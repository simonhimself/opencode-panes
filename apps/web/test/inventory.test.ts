import { exportJWK, generateKeyPair, SignJWT, errors, type JWK } from "jose";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { clearAccessJwksCache } from "../worker/access";
import { inventoryResponseSchema } from "@opencode-panes/contracts";

const ORIGIN = "https://panes.example";
const KEY_MATERIAL =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface AccessMaterial {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  jwk: JWK;
  issuer: string;
  audience: string;
}

beforeEach(async () => {
  clearAccessJwksCache();
  vi.unstubAllGlobals();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM publications"),
    env.DB.prepare("DELETE FROM creator_links"),
    env.DB.prepare("DELETE FROM revision_files"),
    env.DB.prepare("DELETE FROM local_revisions"),
    env.DB.prepare("DELETE FROM sync_artifacts"),
    env.DB.prepare("DELETE FROM local_artifacts"),
    env.DB.prepare("DELETE FROM projects"),
  ]);
});

describe("authenticated cloud inventory", () => {
  it("rejects missing or invalid configuration before querying inventory", async () => {
    const unauthorized = await api("/api/inventory");
    expect(unauthorized.status).toBe(503);
    expect(await unauthorized.text()).not.toContain("project");

    const noHeaderEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
      PANES_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
      PANES_ACCESS_AUDIENCE: "inventory-audience",
      PANES_ACCESS_ALLOWED_EMAIL: "simonhimself@gmail.com",
    };
    const missing = await api("/api/inventory", undefined, noHeaderEnv);
    expect(missing.status).toBe(401);
    const missingBody = await missing.text();
    expect(missingBody).not.toContain("email");
    expect(missingBody).not.toContain("inventory");

    const malformed = await api(
      "/api/inventory",
      { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } },
      noHeaderEnv,
    );
    expect(malformed.status).toBe(401);
  });

  it("returns a generic service-unavailable response when JWKS times out", async () => {
    const material = await accessMaterial("timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new errors.JWKSTimeout())),
    );
    const response = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(material),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("timeout");
  });

  it("accepts a valid signed Access JWT without an nbf claim", async () => {
    const material = await accessMaterial("without-nbf");
    stubJwks(material);
    const response = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
            missingNbf: true,
          }),
        },
      },
      accessEnv(material),
    );
    expect(response.status).toBe(200);
  });

  it("accepts only a valid signed Access JWT and groups committed Artifacts", async () => {
    const material = await accessMaterial("one");
    const fetchJwks = stubJwks(material);
    await seedInventory();
    const token = await accessToken(material, {
      email: "SIMONHIMSELF@GMAIL.COM",
    });
    const response = await api(
      "/api/inventory",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      accessEnv(material),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const inventory = inventoryResponseSchema.parse(await response.json());
    expect(inventory.projects).toHaveLength(1);
    expect(inventory.projects[0]).toMatchObject({
      projectId: "cloud-project-one",
      artifacts: [
        {
          artifactId: "cloud-artifact-one",
          title: "Inventory one",
          revisionCount: 2,
          storageBytes: 9,
          lastSyncedAt: "2026-08-29T12:02:00.000Z",
          creatorLink: {
            status: "active",
            expiresAt: "2026-09-28T12:00:00.000Z",
          },
          publication: {
            status: "active",
            revisionVersion: 2,
            expiresAt: "2026-09-05T12:00:00.000Z",
            publicUrl: "https://panes.example/published/public-token-one",
          },
          warnings: [],
        },
        {
          artifactId: "cloud-artifact-two",
          title: "Inventory two",
          revisionCount: 1,
          storageBytes: 3,
          publication: {
            status: "expired",
            revisionVersion: 1,
            expiresAt: "2020-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    expect(JSON.stringify(inventory)).not.toContain("token_hash");
    expect(JSON.stringify(inventory)).not.toContain("ciphertext");
    expect(JSON.stringify(inventory)).not.toContain("object_key");
    expect(fetchJwks).toHaveBeenCalledOnce();
  });

  it("isolates a damaged active publication and refreshes rotated JWKS keys", async () => {
    const first = await accessMaterial("first");
    const second = await accessMaterial("second");
    let current = first;
    const fetchJwks = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [current.jwk] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchJwks);
    await seedInventory({ damagedSecondPublication: true });

    const firstResponse = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(first, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(first),
    );
    expect(firstResponse.status).toBe(200);
    const firstInventory = inventoryResponseSchema.parse(
      await firstResponse.json(),
    );
    expect(firstInventory.projects[0]?.artifacts[1]?.warnings).toEqual([
      "The active public URL could not be recovered.",
    ]);
    expect(
      firstInventory.projects[0]?.artifacts[0]?.publication.publicUrl,
    ).toBe("https://panes.example/published/public-token-one");

    current = second;
    const rotated = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(second, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(second),
    );
    expect(rotated.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("reports expired and revoked lifecycle state without exposing history internals", async () => {
    const material = await accessMaterial("lifecycle");
    stubJwks(material);
    await seedInventory();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE creator_links SET revoked_at = ? WHERE artifact_id = ?",
      ).bind("2026-08-29T12:03:00.000Z", "cloud-artifact-one"),
      env.DB.prepare(
        "UPDATE publications SET status = 'revoked', revoked_at = ?, token_ciphertext = NULL, token_nonce = NULL, encryption_key_version = NULL WHERE artifact_id = ?",
      ).bind("2026-08-29T12:03:00.000Z", "cloud-artifact-one"),
    ]);
    const response = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(material),
    );
    const inventory = inventoryResponseSchema.parse(await response.json());
    expect(inventory.projects[0]?.artifacts[0]).toMatchObject({
      creatorLink: { status: "revoked" },
      publication: {
        status: "revoked",
        revisionVersion: 2,
      },
    });
    expect(inventory.projects[0]?.artifacts[0]?.publication).not.toHaveProperty(
      "publicUrl",
    );
  });

  it.each([
    ["wrong signature", { email: "simonhimself@gmail.com" }],
    ["wrong issuer", { email: "simonhimself@gmail.com", issuer: true }],
    ["wrong audience", { email: "simonhimself@gmail.com", audience: true }],
    ["wrong email", { email: "other@example.com" }],
    ["expired", { email: "simonhimself@gmail.com", expired: true }],
    ["not yet valid", { email: "simonhimself@gmail.com", notYetValid: true }],
  ] as const)("fails closed for %s", async (name, options) => {
    const material = await accessMaterial(`invalid-${name}`);
    const other = await accessMaterial(`other-${name}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [material.jwk] }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const token = await accessToken(
      name === "wrong signature" ? other : material,
      options,
    );
    const response = await api(
      "/api/inventory",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      accessEnv(material),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(name);
  });
});

async function accessMaterial(label: string): Promise<AccessMaterial> {
  const safeLabel = label.replace(/[^a-z0-9-]/giu, "-");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = `inventory-${safeLabel}`;
  jwk.use = "sig";
  return {
    privateKey,
    jwk,
    issuer: `https://team-${safeLabel}.cloudflareaccess.com`,
    audience: `inventory-audience-${safeLabel}`,
  };
}

async function accessToken(
  material: AccessMaterial,
  options: {
    email: string;
    issuer?: boolean;
    audience?: boolean;
    expired?: boolean;
    notYetValid?: boolean;
    missingNbf?: boolean;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const token = new SignJWT({ email: options.email })
    .setProtectedHeader({ alg: "RS256", kid: String(material.jwk.kid) })
    .setIssuer(
      options.issuer ? "https://wrong.cloudflareaccess.com" : material.issuer,
    )
    .setAudience(options.audience ? "wrong-audience" : material.audience)
    .setIssuedAt(now);
  if (!options.missingNbf)
    token.setNotBefore(options.notYetValid ? now + 300 : now - 5);
  return token
    .setExpirationTime(options.expired ? now - 1 : now + 300)
    .sign(material.privateKey);
}

function stubJwks(material: AccessMaterial) {
  const fetchJwks = vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [material.jwk] }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchJwks);
  return fetchJwks;
}

function accessEnv(material: { issuer: string; audience: string }): Env {
  return {
    DB: env.DB,
    PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
    PUBLICATION_ENCRYPTION_KEY_V1: KEY_MATERIAL,
    PANES_ACCESS_ISSUER: material.issuer,
    PANES_ACCESS_AUDIENCE: material.audience,
    PANES_ACCESS_ALLOWED_EMAIL: "simonhimself@gmail.com",
  };
}

async function seedInventory(
  options: { damagedSecondPublication?: boolean } = {},
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(
      "local-project-one",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_artifacts (id, project_id, slug, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-one",
      "local-project-one",
      "inventory-one",
      "Inventory one",
      "prototype",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO sync_artifacts (cloud_artifact_id, cloud_project_id, local_project_id, local_artifact_id, slug, title, kind, owner_token_hash, creation_idempotency_key, creator_token_hash, creator_created_at, creator_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-one",
      "cloud-project-one",
      "local-project-one",
      "local-artifact-one",
      "inventory-one",
      "Inventory one",
      "prototype",
      "a".repeat(64),
      "inventory-create-one",
      "b".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO creator_links (id, artifact_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "creator-link-one",
      "cloud-artifact-one",
      "c".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_revisions (id, artifact_id, version, preview_entry, approved_origins, created_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-one-v1",
      "cloud-artifact-one",
      1,
      '{"adapter":"browser","entryPath":"index.html"}',
      "[]",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:01:00.000Z",
      "revision-one-v2",
      "cloud-artifact-one",
      2,
      '{"adapter":"browser","entryPath":"index.html"}',
      "[]",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO revision_files (revision_id, path, sha256, byte_size, media_type, object_key) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-one-v1",
      "index.html",
      "d".repeat(64),
      2,
      "text/html",
      "private/one/v1/index.html",
      "revision-one-v2",
      "index.html",
      "e".repeat(64),
      3,
      "text/html",
      "private/one/v2/index.html",
      "revision-one-v2",
      "assets/app.js",
      "f".repeat(64),
      4,
      "text/javascript",
      "private/one/v2/assets/app.js",
    ),
    env.DB.prepare(
      "INSERT INTO publications (id, artifact_id, revision_version, duration_days, token_hash, token_ciphertext, token_nonce, encryption_key_version, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "publication-one",
      "cloud-artifact-one",
      2,
      7,
      "1".repeat(64),
      await encryptedToken(
        "public-token-one",
        "cloud-artifact-one",
        "publication-one",
      ),
      "00112233445566778899aabb",
      1,
      "active",
      "2026-08-29T12:00:00.000Z",
      "2026-09-05T12:00:00.000Z",
    ),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(
      "local-project-two",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_artifacts (id, project_id, slug, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-two",
      "local-project-two",
      "inventory-two",
      "Inventory two",
      null,
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO sync_artifacts (cloud_artifact_id, cloud_project_id, local_project_id, local_artifact_id, slug, title, kind, owner_token_hash, creation_idempotency_key, creator_token_hash, creator_created_at, creator_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-two",
      "cloud-project-one",
      "local-project-two",
      "local-artifact-two",
      "inventory-two",
      "Inventory two",
      null,
      "a".repeat(64),
      "inventory-create-two",
      "b".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO creator_links (id, artifact_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "creator-link-two",
      "cloud-artifact-two",
      "c".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_revisions (id, artifact_id, version, preview_entry, approved_origins, created_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-two-v1",
      "cloud-artifact-two",
      1,
      '{"adapter":"browser","entryPath":"index.html"}',
      "[]",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO revision_files (revision_id, path, sha256, byte_size, media_type, object_key) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-two-v1",
      "index.html",
      "a".repeat(64),
      3,
      "text/html",
      "private/two/v1/index.html",
    ),
    env.DB.prepare(
      "INSERT INTO publications (id, artifact_id, revision_version, duration_days, token_hash, token_ciphertext, token_nonce, encryption_key_version, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "publication-two",
      "cloud-artifact-two",
      1,
      7,
      "2".repeat(64),
      options.damagedSecondPublication ? "tampered" : null,
      "00112233445566778899aabb",
      1,
      options.damagedSecondPublication ? "active" : "expired",
      "2026-08-29T12:00:00.000Z",
      options.damagedSecondPublication
        ? "2026-09-05T12:00:00.000Z"
        : "2020-01-01T00:00:00.000Z",
    ),
  ]);
}

async function encryptedToken(
  token: string,
  artifactId: string,
  publicationId: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexBytes(KEY_MATERIAL).buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = hexBytes("00112233445566778899aabb");
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce.buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(
        `opencode-panes/publication/${artifactId}/${publicationId}/key-v1`,
      ).buffer as ArrayBuffer,
    },
    key,
    new TextEncoder().encode(token).buffer as ArrayBuffer,
  );
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
}

async function api(path: string, init?: RequestInit, workerEnv: Env = env) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv);
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
}
