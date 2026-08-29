import { exportJWK, generateKeyPair, SignJWT, errors, type JWK } from "jose";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { clearAccessJwksCache } from "../worker/access";
import {
  cloudDeletionConfirmation,
  deleteInventoryArtifact,
} from "../worker/deletion";
import {
  inventoryReconnectCodeResponseSchema,
  inventoryCreatorRotateResponseSchema,
  inventoryResponseSchema,
  publicationSchema,
  syncReconnectResponseSchema,
} from "@opencode-panes/contracts";
import { reconnectCodeConfirmation } from "../worker/inventory";
import { readBoundedText } from "../worker/bounded-json";
import { privateRevisionObjectKey } from "../worker/storage";

const ORIGIN = "https://panes.example";
const RECONNECT_MANIFEST_V2_KEY =
  "private/manifests/636c6f75642d70726f6a6563742d6f6e65/636c6f75642d61727469666163742d6f6e65/v2.json";
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
    env.DB.prepare("DELETE FROM artifact_deletion_objects"),
    env.DB.prepare("DELETE FROM artifact_deletion_tombstones"),
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
  it("issues one-time hashed reconnect codes with a bounded TTL and replaces only the Owner credential", async () => {
    const material = await accessMaterial("reconnect");
    stubJwks(material);
    await seedInventory();
    await seedReconnectManifests();
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const confirmation = reconnectCodeConfirmation(
      "cloud-artifact-one",
      "Inventory one",
    );
    const issue = () =>
      api(
        "/api/inventory/artifacts/cloud-artifact-one/reconnect-code",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ confirmation }),
        },
        accessEnv(material),
      );
    const first = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    expect(first.reconnectCode).toMatch(/^panes-reconnect-[a-f0-9]{32}$/u);
    expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(
      9 * 60_000,
    );
    expect(Date.parse(first.expiresAt) - Date.now()).toBeLessThanOrEqual(
      10 * 60_000,
    );
    const storedFirst = await env.DB.prepare(
      "SELECT code_hash, expires_at, consumed_at, revoked_at FROM owner_reconnect_codes WHERE artifact_id = ? ORDER BY created_at ASC LIMIT 1",
    )
      .bind("cloud-artifact-one")
      .first<{
        code_hash: string;
        expires_at: string;
        consumed_at: string | null;
        revoked_at: string | null;
      }>();
    expect(storedFirst).toMatchObject({
      code_hash: await sha256Text(first.reconnectCode),
      expires_at: first.expiresAt,
      consumed_at: null,
      revoked_at: null,
    });
    expect(JSON.stringify(storedFirst)).not.toContain(first.reconnectCode);

    const second = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    expect(second.reconnectCode).not.toBe(first.reconnectCode);
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM owner_reconnect_codes WHERE code_hash = ?",
      )
        .bind(await sha256Text(first.reconnectCode))
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: expect.any(String) });

    await env.DB.prepare(
      "UPDATE owner_reconnect_codes SET expires_at = ? WHERE code_hash = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", await sha256Text(second.reconnectCode))
      .run();
    const expired = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: second.reconnectCode,
          newOwnerCredential: "expired-owner",
        }),
      },
      accessEnv(material),
    );
    expect(expired.status).toBe(403);
    const third = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    const wrongArtifact = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-two",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "wrong-artifact-owner",
        }),
      },
      accessEnv(material),
    );
    expect(wrongArtifact.status).toBe(403);

    const manifestObject = await env.PRIVATE_ARTIFACTS.get(
      RECONNECT_MANIFEST_V2_KEY,
    );
    if (!manifestObject) throw new Error("reconnect manifest fixture missing");
    const originalManifest = await manifestObject.text();
    const corruptManifest = JSON.parse(originalManifest) as {
      revisions: Array<{ files: Array<{ sha256?: string }> }>;
    };
    const secondManifest = corruptManifest.revisions[1];
    const firstFile = secondManifest?.files[0];
    if (!firstFile) throw new Error("reconnect revision fixture missing");
    firstFile.sha256 = "0".repeat(64);
    await env.PRIVATE_ARTIFACTS.put(
      RECONNECT_MANIFEST_V2_KEY,
      JSON.stringify(corruptManifest),
    );
    const corruptR2 = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "corrupt-r2-owner",
        }),
      },
      accessEnv(material),
    );
    expect(corruptR2.status).toBe(409);
    await env.PRIVATE_ARTIFACTS.put(
      RECONNECT_MANIFEST_V2_KEY,
      originalManifest,
    );

    await env.DB.prepare(
      "UPDATE revision_files SET sha256 = ? WHERE revision_id = ? AND path = ?",
    )
      .bind("0".repeat(64), "revision-one-v2", "index.html")
      .run();
    const corrupt = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "corrupt-owner",
        }),
      },
      accessEnv(material),
    );
    expect(corrupt.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT owner_token_hash FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ owner_token_hash: string }>(),
    ).toMatchObject({ owner_token_hash: "a".repeat(64) });
    expect(
      await env.DB.prepare(
        "SELECT consumed_at FROM owner_reconnect_codes WHERE code_hash = ?",
      )
        .bind(await sha256Text(third.reconnectCode))
        .first<{ consumed_at: string | null }>(),
    ).toMatchObject({ consumed_at: null });
    await env.DB.prepare(
      "UPDATE revision_files SET sha256 = ? WHERE revision_id = ? AND path = ?",
    )
      .bind("e".repeat(64), "revision-one-v2", "index.html")
      .run();

    const before = await env.DB.prepare(
      "SELECT owner_token_hash, creator_token_hash FROM sync_artifacts WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .first<{ owner_token_hash: string; creator_token_hash: string }>();
    const redeemed = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "replacement-owner-credential",
        }),
      },
      accessEnv(material),
    );
    expect(redeemed.status).toBe(200);
    const response = syncReconnectResponseSchema.parse(await redeemed.json());
    expect(response.creatorLink.status).toBe("active");
    expect(response.publication).toEqual({
      status: "active",
      revisionVersion: 2,
      expiresAt: "2026-09-05T12:00:00.000Z",
    });
    expect(
      response.syncedRevisionManifests.map((revision) => revision.version),
    ).toEqual([1, 2]);
    const after = await env.DB.prepare(
      "SELECT owner_token_hash, creator_token_hash FROM sync_artifacts WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .first<{ owner_token_hash: string; creator_token_hash: string }>();
    expect(after?.owner_token_hash).toBe(
      await sha256Text("replacement-owner-credential"),
    );
    expect(after?.owner_token_hash).not.toBe(before?.owner_token_hash);
    expect(after?.creator_token_hash).toBe(before?.creator_token_hash);
    expect(
      await env.DB.prepare(
        "SELECT consumed_at FROM owner_reconnect_codes WHERE code_hash = ?",
      )
        .bind(await sha256Text(third.reconnectCode))
        .first<{ consumed_at: string | null }>(),
    ).toMatchObject({ consumed_at: expect.any(String) });

    const oldOwner = await api(
      "/api/sync/artifacts/cloud-artifact-one/lease/release",
      {
        method: "POST",
        headers: { Authorization: "Bearer old-owner" },
      },
      accessEnv(material),
    );
    expect(oldOwner.status).toBe(403);
    const newOwner = await api(
      "/api/sync/artifacts/cloud-artifact-one/lease/release",
      {
        method: "POST",
        headers: { Authorization: "Bearer replacement-owner-credential" },
      },
      accessEnv(material),
    );
    expect(newOwner.status).toBe(204);

    const reused = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "another-owner",
        }),
      },
      accessEnv(material),
    );
    expect(reused.status).toBe(403);

    const concurrent = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    const redeemConcurrently = (newOwnerCredential: string) =>
      api(
        "/api/sync/artifacts/cloud-artifact-one/reconnect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiOrigin: ORIGIN,
            localProjectId: "local-project-one",
            localArtifactId: "local-artifact-one",
            cloudProjectId: "cloud-project-one",
            cloudArtifactId: "cloud-artifact-one",
            reconnectCode: concurrent.reconnectCode,
            newOwnerCredential,
          }),
        },
        accessEnv(material),
      );
    const concurrentResults = await Promise.all([
      redeemConcurrently("concurrent-owner-a"),
      redeemConcurrently("concurrent-owner-b"),
    ]);
    expect(
      concurrentResults.filter((result) => result.status === 200),
    ).toHaveLength(1);
    expect(concurrentResults.some((result) => result.status !== 200)).toBe(
      true,
    );
  });

  it("rejects recovery confirmation and deleting Artifacts without disclosing metadata", async () => {
    const material = await accessMaterial("reconnect-boundaries");
    stubJwks(material);
    await seedInventory();
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const incorrect = await api(
      "/api/inventory/artifacts/cloud-artifact-one/reconnect-code",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "RECOVER OWNER CREDENTIAL" }),
      },
      accessEnv(material),
    );
    expect(incorrect.status).toBe(400);
    await env.DB.prepare(
      "UPDATE sync_artifacts SET lifecycle_state = 'deleting' WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .run();
    const deleting = await api(
      "/api/inventory/artifacts/cloud-artifact-one/reconnect-code",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          confirmation: reconnectCodeConfirmation(
            "cloud-artifact-one",
            "Inventory one",
          ),
        }),
      },
      accessEnv(material),
    );
    expect(deleting.status).toBe(409);
    expect(await deleting.text()).not.toContain("Inventory one");
  });

  it("cancels a chunked body as soon as it exceeds the byte limit", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    const text = await readBoundedText(
      new Request(ORIGIN, { body, method: "POST" }),
      10,
    );
    expect(text).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("protects every inventory mutation before looking up an Artifact", async () => {
    const response = await api(
      "/api/inventory/artifacts/missing-artifact/creator/rotate",
      { method: "POST", body: "{}" },
      {
        DB: env.DB,
        PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
        PANES_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
        PANES_ACCESS_AUDIENCE: "inventory-audience",
        PANES_ACCESS_ALLOWED_EMAIL: "simonhimself@gmail.com",
      },
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("missing-artifact");
  });

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

  it("rotates Creator access and applies shared Publication rules", async () => {
    const material = await accessMaterial("mutations");
    stubJwks(material);
    await seedInventory();
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
    };

    const rotated = await api(
      "/api/inventory/artifacts/cloud-artifact-one/creator/rotate",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      },
      accessEnv(material),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = inventoryCreatorRotateResponseSchema.parse(
      await rotated.json(),
    );
    expect(rotatedBody.creatorUrl).toMatch(
      /^https:\/\/panes\.example\/creator\/[^/]+$/u,
    );
    expect(Date.parse(rotatedBody.creatorExpiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(JSON.stringify(rotatedBody)).not.toContain("creatorToken");

    const extended = await api(
      "/api/inventory/artifacts/cloud-artifact-one/publication/extend",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ durationDays: 1 }),
      },
      accessEnv(material),
    );
    expect(extended.status).toBe(200);
    expect(publicationSchema.parse(await extended.json()).expiresAt).toBe(
      "2026-09-06T12:00:00.000Z",
    );
  });

  it("requires exact cloud deletion confirmation and preserves a resumable tombstone", async () => {
    const material = await accessMaterial("delete");
    stubJwks(material);
    await seedInventory();
    const revisionKey = "private/one/v2/index.html";
    const manifestKey =
      "private/manifests/cloud-project-one/cloud-artifact-one/v2.json";
    await env.DB.prepare(
      "UPDATE local_revisions SET cloud_manifest_key = ? WHERE artifact_id = ? AND version = 2",
    )
      .bind(manifestKey, "cloud-artifact-one")
      .run();
    await env.PRIVATE_ARTIFACTS.put(revisionKey, "revision bytes");
    await env.PRIVATE_ARTIFACTS.put(manifestKey, "manifest bytes");
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const path = "/api/inventory/artifacts/cloud-artifact-one";
    const incorrect = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
      accessEnv(material),
    );
    expect(incorrect.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();

    const padded = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: `${cloudDeletionConfirmation("Inventory one")} `,
        }),
      },
      accessEnv(material),
    );
    expect(padded.status).toBe(400);

    const deleted = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );
    expect(deleted.status).toBe(204);
    expect(await env.PRIVATE_ARTIFACTS.head(revisionKey)).toBeNull();
    expect(await env.PRIVATE_ARTIFACTS.head(manifestKey)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM local_artifacts WHERE id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM revision_files WHERE revision_id LIKE 'revision-one-%'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM sync_uploads WHERE artifact_id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM creator_links WHERE artifact_id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM publications WHERE artifact_id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM projects WHERE id = ?")
        .bind("local-project-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM artifact_deletion_objects WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    const tombstone = await env.DB.prepare(
      "SELECT * FROM artifact_deletion_tombstones WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .first<Record<string, unknown>>();
    expect(tombstone?.completed_at).toEqual(expect.any(String));
    expect(JSON.stringify(tombstone)).not.toMatch(
      /token|ciphertext|nonce|object_key|file contents/iu,
    );

    const replay = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );
    expect(replay.status).toBe(204);
  });

  it("retries deletion after an R2 failure without deleting D1 metadata early", async () => {
    const material = await accessMaterial("delete-retry");
    stubJwks(material);
    await seedInventory();
    const failingBucket = {
      delete: async () => {
        throw new Error("injected R2 failure");
      },
    } as unknown as R2Bucket;
    const failingEnv = {
      ...accessEnv(material),
      PRIVATE_ARTIFACTS: failingBucket,
    } as Env;
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const request = () =>
      new Request(`${ORIGIN}/api/inventory/artifacts/cloud-artifact-one`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      });
    await expect(
      deleteInventoryArtifact(request(), failingEnv, "cloud-artifact-one"),
    ).rejects.toThrow("injected R2 failure");
    expect(
      await env.DB.prepare(
        "SELECT lifecycle_state FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ lifecycle_state: string }>(),
    ).toMatchObject({
      lifecycle_state: "deleting",
    });
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();

    const retried = await deleteInventoryArtifact(
      request(),
      accessEnv(material),
      "cloud-artifact-one",
    );
    expect(retried.status).toBe(204);
  });

  it("does not revoke capabilities when deletion cannot acquire both leases", async () => {
    const material = await accessMaterial("busy-delete");
    stubJwks(material);
    await seedInventory();
    await env.DB.prepare(
      "UPDATE sync_artifacts SET sync_lease_owner = ?, sync_lease_expires_at = ? WHERE cloud_artifact_id = ?",
    )
      .bind("other-session", "2099-01-01T00:00:00.000Z", "cloud-artifact-one")
      .run();
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one",
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM creator_links WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: null });
    expect(
      await env.DB.prepare(
        "SELECT status, token_ciphertext FROM publications WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ status: string; token_ciphertext: string | null }>(),
    ).toMatchObject({
      status: "active",
      token_ciphertext: expect.any(String),
    });
  });

  it("rejects an oversized chunked deletion body before buffering it fully", async () => {
    const material = await accessMaterial("oversized-delete");
    stubJwks(material);
    await seedInventory();
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"confirmation":"'));
        controller.enqueue(new Uint8Array(5000).fill(65));
        controller.close();
      },
    });
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one",
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body: chunks,
      },
      accessEnv(material),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT lifecycle_state FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ lifecycle_state: string }>(),
    ).toMatchObject({ lifecycle_state: "active" });
  });

  it("rejects an oversized chunked inventory mutation body", async () => {
    const material = await accessMaterial("oversized-mutation");
    stubJwks(material);
    await seedInventory();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"durationDays":7,'));
        controller.enqueue(new Uint8Array(5000).fill(65));
        controller.close();
      },
    });
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one/publication/extend",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body,
      },
      accessEnv(material),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT expires_at FROM publications WHERE id = ?")
        .bind("publication-one")
        .first<{ expires_at: string }>(),
    ).toMatchObject({ expires_at: "2026-09-05T12:00:00.000Z" });
  });

  it("retains an object that remains committed by another Artifact", async () => {
    const material = await accessMaterial("shared-object");
    stubJwks(material);
    await seedInventory();
    const sharedKey = "private/shared/committed/manifest.json";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE local_revisions SET cloud_manifest_key = ? WHERE artifact_id = ?",
      ).bind(sharedKey, "cloud-artifact-two"),
      env.DB.prepare(
        "UPDATE local_revisions SET cloud_manifest_key = ? WHERE artifact_id = ?",
      ).bind(sharedKey, "cloud-artifact-one"),
    ]);
    await env.PRIVATE_ARTIFACTS.put(sharedKey, "shared manifest");
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one",
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );

    expect(response.status).toBe(204);
    expect(await env.PRIVATE_ARTIFACTS.head(sharedKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ? AND cloud_manifest_key = ?",
      )
        .bind("cloud-artifact-two", sharedKey)
        .first(),
    ).not.toBeNull();
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
          lifecycleState: "active",
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
          lifecycleState: "active",
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
    const retainedObjectKey = "private/one/v2/index.html";
    await env.PRIVATE_ARTIFACTS.put(retainedObjectKey, "canonical cloud bytes");
    await env.DB.prepare(
      "UPDATE creator_links SET expires_at = ?, revoked_at = NULL WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "cloud-artifact-one")
      .run();
    await env.DB.prepare(
      "UPDATE publications SET expires_at = ?, status = 'active', revoked_at = NULL WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "cloud-artifact-one")
      .run();
    const expiredResponse = await api(
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
    const expiredInventory = inventoryResponseSchema.parse(
      await expiredResponse.json(),
    );
    expect(expiredInventory.projects[0]?.artifacts[0]).toMatchObject({
      creatorLink: { status: "expired" },
      publication: { status: "expired" },
    });
    expect(await env.PRIVATE_ARTIFACTS.head(retainedObjectKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ? AND committed_at IS NOT NULL",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();
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
    expect(await env.PRIVATE_ARTIFACTS.head(retainedObjectKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ? AND committed_at IS NOT NULL",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();
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

async function seedReconnectManifests() {
  const manifests = [
    {
      key: "private/manifests/636c6f75642d70726f6a6563742d6f6e65/636c6f75642d61727469666163742d6f6e65/v1.json",
      revision: {
        id: "revision-one-v1",
        version: 1,
        preview: { adapter: "browser", entryPath: "index.html" },
        approvedOrigins: [],
        files: [
          {
            kind: "file",
            path: "index.html",
            sha256: "d".repeat(64),
            byteSize: 2,
            mediaType: "text/html",
          },
        ],
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    },
    {
      key: RECONNECT_MANIFEST_V2_KEY,
      revision: {
        id: "revision-one-v2",
        version: 2,
        preview: { adapter: "browser", entryPath: "index.html" },
        approvedOrigins: [],
        files: [
          {
            kind: "file",
            path: "index.html",
            sha256: "e".repeat(64),
            byteSize: 3,
            mediaType: "text/html",
          },
          {
            kind: "file",
            path: "assets/app.js",
            sha256: "f".repeat(64),
            byteSize: 4,
            mediaType: "text/javascript",
          },
        ],
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    },
  ];
  const manifestV1 = manifests[0];
  const manifestV2 = manifests[1];
  if (!manifestV1 || !manifestV2)
    throw new Error("reconnect fixtures incomplete");
  const fileV1 = privateRevisionObjectKey(
    "cloud-project-one",
    "cloud-artifact-one",
    "revision-one-v1",
    "index.html",
  );
  const fileV2 = privateRevisionObjectKey(
    "cloud-project-one",
    "cloud-artifact-one",
    "revision-one-v2",
    "index.html",
  );
  const appV2 = privateRevisionObjectKey(
    "cloud-project-one",
    "cloud-artifact-one",
    "revision-one-v2",
    "assets/app.js",
  );
  const manifestV2Revisions = [manifestV1.revision, manifestV2.revision];
  for (const { key, revision } of manifests) {
    await env.PRIVATE_ARTIFACTS.put(
      key,
      JSON.stringify({
        schemaVersion: 1,
        projectId: "cloud-project-one",
        artifactId: "cloud-artifact-one",
        slug: "inventory-one",
        title: "Inventory one",
        kind: "prototype",
        revisions: revision.version === 2 ? manifestV2Revisions : [revision],
      }),
    );
  }
  await env.PRIVATE_ARTIFACTS.put(fileV1, "ok", {
    httpMetadata: { contentType: "text/html" },
    customMetadata: { sha256: "d".repeat(64), byteSize: "2" },
  });
  await env.PRIVATE_ARTIFACTS.put(fileV2, "two", {
    httpMetadata: { contentType: "text/html" },
    customMetadata: { sha256: "e".repeat(64), byteSize: "3" },
  });
  await env.PRIVATE_ARTIFACTS.put(appV2, "file", {
    httpMetadata: { contentType: "text/javascript" },
    customMetadata: { sha256: "f".repeat(64), byteSize: "4" },
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE local_revisions SET cloud_manifest_key = ? WHERE id = ?",
    ).bind(manifestV1.key, "revision-one-v1"),
    env.DB.prepare(
      "UPDATE local_revisions SET cloud_manifest_key = ? WHERE id = ?",
    ).bind(manifestV2.key, "revision-one-v2"),
    env.DB.prepare(
      "UPDATE revision_files SET object_key = ? WHERE revision_id = ? AND path = ?",
    ).bind(fileV1, "revision-one-v1", "index.html"),
    env.DB.prepare(
      "UPDATE revision_files SET object_key = ? WHERE revision_id = ? AND path = ?",
    ).bind(fileV2, "revision-one-v2", "index.html"),
    env.DB.prepare(
      "UPDATE revision_files SET object_key = ? WHERE revision_id = ? AND path = ?",
    ).bind(appV2, "revision-one-v2", "assets/app.js"),
  ]);
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function api(path: string, init?: RequestInit, workerEnv: Env = env) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv);
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
}
