import {
  createArtifactResponseSchema,
  creatorWorkspaceResponseSchema,
  publicationSchema,
  shareResponseSchema,
  syncCreateResponseSchema,
} from "@opencode-panes/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../worker/index";

const ORIGIN = "https://panes.example";

function jsonRequest(value: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  };
}

async function api(path: string, init?: RequestInit, workerEnv: Env = env) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv);
}

async function syncedArtifact() {
  const slug = `publication-${crypto.randomUUID()}`;
  const create = await api(
    "/api/sync/artifacts",
    jsonRequest({
      projectId: `publication-project-${crypto.randomUUID()}`,
      artifactId: `publication-artifact-${crypto.randomUUID()}`,
      slug,
      title: "Publication test",
      idempotencyKey: `publication-${crypto.randomUUID()}`,
      ownerCredential: "publication-owner",
      creatorToken: `publication-creator-${crypto.randomUUID()}`,
    }),
  );
  const artifact = syncCreateResponseSchema.parse(await create.json());
  const revision = {
    id: `revision-${crypto.randomUUID()}`,
    version: 1,
    preview: { adapter: "browser" as const, entryPath: "index.html" },
    approvedOrigins: [],
    files: [
      {
        kind: "file" as const,
        path: "index.html",
        sha256: await hash("<h1>publication</h1>"),
        byteSize: new TextEncoder().encode("<h1>publication</h1>").byteLength,
        mediaType: "text/html",
      },
    ],
    createdAt: "2026-08-29T12:00:00.000Z",
  };
  const manifest = {
    schemaVersion: 1 as const,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.cloudArtifactId,
    slug,
    title: "Publication test",
    revisions: [revision],
  };
  const bytes = new TextEncoder().encode("<h1>publication</h1>");
  const file = revision.files[0];
  if (!file) throw new Error("publication test file is missing");
  const upload = await api(
    `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/files/index.html`,
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer publication-owner",
        "Content-Type": "text/html",
        "X-Panes-File-SHA256": file.sha256,
        "X-Panes-File-Byte-Size": String(bytes.byteLength),
      },
      body: bytes,
    },
  );
  expect(upload.status).toBe(204);
  const commit = await api(
    `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
    jsonRequest({ manifest }, "publication-owner"),
  );
  expect(commit.status).toBe(201);
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/lease/release`,
        {
          method: "POST",
          headers: { Authorization: "Bearer publication-owner" },
        },
      )
    ).status,
  ).toBe(204);
  return {
    ...artifact,
    creatorToken: artifact.creatorUrl.split("/").at(-1)!,
    revisionId: revision.id,
    slug,
  };
}

async function syncRevision(
  artifact: Awaited<ReturnType<typeof syncedArtifact>>,
  version: number,
  source: string,
) {
  const revision = {
    id: `revision-${crypto.randomUUID()}`,
    version,
    preview: { adapter: "browser" as const, entryPath: "index.html" },
    approvedOrigins: [],
    files: [
      {
        kind: "file" as const,
        path: "index.html",
        sha256: await hash(source),
        byteSize: new TextEncoder().encode(source).byteLength,
        mediaType: "text/html",
      },
    ],
    createdAt: "2026-08-29T12:00:00.000Z",
  };
  const file = revision.files[0];
  const bytes = new TextEncoder().encode(source);
  if (!file) throw new Error("revision test file is missing");
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/${version}/files/index.html`,
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer publication-owner",
            "Content-Type": "text/html",
            "X-Panes-File-SHA256": file.sha256,
            "X-Panes-File-Byte-Size": String(bytes.byteLength),
          },
          body: bytes,
        },
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/lease/release`,
        {
          method: "POST",
          headers: { Authorization: "Bearer publication-owner" },
        },
      )
    ).status,
  ).toBe(204);
  const manifest = {
    schemaVersion: 1 as const,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.cloudArtifactId,
    slug: artifact.slug,
    title: "Publication test",
    revisions: [
      {
        id: artifact.revisionId,
        version: 1,
        preview: { adapter: "browser" as const, entryPath: "index.html" },
        approvedOrigins: [],
        files: [
          {
            kind: "file" as const,
            path: "index.html",
            sha256: await hash("<h1>publication</h1>"),
            byteSize: new TextEncoder().encode("<h1>publication</h1>")
              .byteLength,
            mediaType: "text/html",
          },
        ],
        createdAt: "2026-08-29T12:00:00.000Z",
      },
      revision,
    ],
  };
  const commit = await api(
    `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/${version}/commit`,
    jsonRequest({ manifest }, "publication-owner"),
  );
  expect(commit.status).toBe(201);
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/lease/release`,
        {
          method: "POST",
          headers: { Authorization: "Bearer publication-owner" },
        },
      )
    ).status,
  ).toBe(204);
}

async function legacyPublishedToken() {
  const created = createArtifactResponseSchema.parse(
    await (
      await api(
        "/api/artifacts",
        jsonRequest({
          title: "Legacy publication",
          type: "html",
          source: "<h1>legacy</h1>",
          sessionId: `legacy-${crypto.randomUUID()}`,
        }),
      )
    ).json(),
  );
  const response = await api(
    `/api/artifacts/${created.artifact.id}/publish`,
    jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
  );
  const published = shareResponseSchema.parse(await response.json());
  return new URL(published.publicUrl).pathname.split("/").at(-1)!;
}

describe("local-first publication lifecycle", () => {
  it("publishes one selected Revision with a defaultable explicit duration", async () => {
    const artifact = await syncedArtifact();
    const publish = await api(
      `/api/creator/${artifact.creatorToken}/publish`,
      jsonRequest({ revisionVersion: 1, durationDays: 7 }),
    );
    expect(publish.status).toBe(201);
    const publication = publicationSchema.parse(await publish.json());
    expect(publication).toMatchObject({
      artifactId: artifact.cloudArtifactId,
      revisionVersion: 1,
      durationDays: 7,
      status: "active",
    });
    expect(publication.publicUrl).toMatch(
      /^https:\/\/panes\.example\/published\//u,
    );

    const stored = await env.DB.prepare(
      "SELECT * FROM publications WHERE id = ?",
    )
      .bind(publication.id)
      .first<{
        token_hash: string;
        token_ciphertext: string;
        token_nonce: string;
        encryption_key_version: number;
      }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.token_ciphertext).toEqual(expect.any(String));
    expect(stored?.token_nonce).toMatch(/^[0-9a-f]{24}$/u);
    expect(stored?.encryption_key_version).toBe(1);
    const indexes = await env.DB.prepare(
      "PRAGMA index_list(publications)",
    ).all<{
      unique: number;
    }>();
    expect(indexes.results.some((index) => index.unique === 1)).toBe(true);
    const key = await crypto.subtle.importKey(
      "raw",
      hexBytes(
        "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      ),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: hexBytes(stored?.token_nonce ?? ""),
        additionalData: new TextEncoder().encode(
          `opencode-panes/publication/${publication.artifactId}/${publication.id}/key-v1`,
        ),
      },
      key,
      base64Bytes(stored?.token_ciphertext ?? ""),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(
      publication.publicUrl!.split("/").at(-1),
    );
    expect(JSON.stringify(stored)).not.toContain(
      new URL(publication.publicUrl!).pathname.split("/").at(-1),
    );
  });

  it("reuses same-active state without extending, and supports explicit actions", async () => {
    const artifact = await syncedArtifact();
    const path = `/api/creator/${artifact.creatorToken}/publish`;
    const first = publicationSchema.parse(
      await (
        await api(path, jsonRequest({ revisionVersion: 1, durationDays: 1 }))
      ).json(),
    );
    const replay = publicationSchema.parse(
      await (
        await api(path, jsonRequest({ revisionVersion: 1, durationDays: 30 }))
      ).json(),
    );
    expect(replay.id).toBe(first.id);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(replay.publicUrl).toBe(first.publicUrl);

    const extended = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/extend`,
          jsonRequest({ durationDays: 1 }),
        )
      ).json(),
    );
    expect(Date.parse(extended.expiresAt)).toBe(
      Date.parse(first.expiresAt) + 24 * 60 * 60 * 1000,
    );
    expect(
      (
        await api(`/api/creator/${artifact.creatorToken}/unpublish`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    expect(
      (await api(`/api/publications/${first.publicUrl!.split("/").at(-1)}`))
        .status,
    ).toBe(410);
    const workspace = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(workspace.publication).toBeNull();
    expect(workspace.publicationHistory?.[0]?.status).toBe("revoked");
  });

  it("fails closed when active ciphertext is tampered or the key is missing", async () => {
    const artifact = await syncedArtifact();
    const publish = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    await env.DB.prepare(
      "UPDATE publications SET token_ciphertext = ? WHERE id = ?",
    )
      .bind("tampered", publish.id)
      .run();
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(500);
    const logs = JSON.stringify(logSpy.mock.calls);
    expect(logs).not.toContain(artifact.creatorToken);
    expect(logs).not.toContain(publish.publicUrl!.split("/").at(-1));
    expect(logs).toContain("/api/creator/:token/publication-action");
    logSpy.mockRestore();
    const afterTamper = await env.DB.prepare(
      "SELECT id, status, token_hash FROM publications WHERE artifact_id = ?",
    )
      .bind(artifact.cloudArtifactId)
      .all<{ id: string; status: string; token_hash: string }>();
    expect(afterTamper.results).toHaveLength(1);
    expect(afterTamper.results[0]).toMatchObject({
      id: publish.id,
      status: "active",
    });

    const noKeyEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
    };
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
          noKeyEnv,
        )
      ).status,
    ).toBe(500);
  });

  it("replaces another revision and republishes after revoke or expiry", async () => {
    const artifact = await syncedArtifact();
    await syncRevision(artifact, 2, "<h1>second</h1>");
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const firstStored = await env.DB.prepare(
      "SELECT token_nonce FROM publications WHERE id = ?",
    )
      .bind(first.id)
      .first<{ token_nonce: string }>();
    const replacement = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 2, durationDays: 1 }),
        )
      ).json(),
    );
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.revisionVersion).toBe(2);
    const replacementStored = await env.DB.prepare(
      "SELECT token_nonce FROM publications WHERE id = ?",
    )
      .bind(replacement.id)
      .first<{ token_nonce: string }>();
    expect(replacementStored?.token_nonce).toMatch(/^[0-9a-f]{24}$/u);
    expect(replacementStored?.token_nonce).not.toBe(firstStored?.token_nonce);
    expect(
      (await api(`/api/publications/${first.publicUrl!.split("/").at(-1)}`))
        .status,
    ).toBe(410);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM publications WHERE artifact_id = ? AND status = 'active'",
        )
          .bind(artifact.cloudArtifactId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const republishedAfterRevoke = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/republish`,
          jsonRequest({ revisionVersion: 2, durationDays: 1 }),
        )
      ).json(),
    );
    expect(republishedAfterRevoke.id).not.toBe(replacement.id);
    await env.DB.prepare("UPDATE publications SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", republishedAfterRevoke.id)
      .run();
    const republished = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/republish`,
          jsonRequest({ revisionVersion: 2, durationDays: 30 }),
        )
      ).json(),
    );
    expect(republished.id).not.toBe(replacement.id);
    expect(republished.publicUrl).not.toBe(replacement.publicUrl);
    const workspace = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    const historyStatuses = workspace.publicationHistory?.map(
      (item) => item.status,
    );
    expect(
      historyStatuses?.filter((status) => status === "active"),
    ).toHaveLength(1);
    expect(
      historyStatuses?.filter((status) => status === "expired"),
    ).toHaveLength(1);
    expect(
      historyStatuses?.filter((status) => status === "revoked"),
    ).toHaveLength(2);
  });

  it("keeps creator expiry independent from publication expiry and isolates legacy routes", async () => {
    const artifact = await syncedArtifact();
    const publication = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const token = publication.publicUrl!.split("/").at(-1)!;
    expect((await api(`/api/public/${token}`)).status).toBe(404);
    const privateSnapshot = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(privateSnapshot.publication?.publicUrl).toBeUndefined();
    await env.DB.prepare(
      "UPDATE creator_links SET expires_at = ? WHERE token_hash = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", await hash(artifact.creatorToken))
      .run();
    expect((await api(`/api/creator/${artifact.creatorToken}`)).status).toBe(
      410,
    );
    expect((await api(`/api/publications/${token}`)).status).toBe(200);

    const legacyToken = await legacyPublishedToken();
    expect((await api(`/api/publications/${legacyToken}`)).status).toBe(404);
    const unknownToken = "a".repeat(64);
    const unknownResponse = await api(`/api/publications/${unknownToken}`);
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.text()).not.toContain(unknownToken);
  });

  it("rejects swapped ciphertext, wrong keys, and unsupported key versions without replacement", async () => {
    const artifact = await syncedArtifact();
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const firstStored = await env.DB.prepare(
      "SELECT token_ciphertext, token_nonce FROM publications WHERE id = ?",
    )
      .bind(first.id)
      .first<{ token_ciphertext: string; token_nonce: string }>();
    await env.DB.prepare(
      "UPDATE publications SET status = 'revoked', revoked_at = ?, token_ciphertext = NULL, token_nonce = NULL, encryption_key_version = NULL WHERE id = ?",
    )
      .bind(new Date().toISOString(), first.id)
      .run();
    const second = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/republish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    await env.DB.prepare(
      "UPDATE publications SET token_ciphertext = ?, token_nonce = ? WHERE id = ?",
    )
      .bind(firstStored?.token_ciphertext, firstStored?.token_nonce, second.id)
      .run();
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(500);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM publications WHERE artifact_id = ? AND status = 'active'",
        )
          .bind(artifact.cloudArtifactId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    await env.DB.prepare(
      "UPDATE publications SET encryption_key_version = 2 WHERE id = ?",
    )
      .bind(second.id)
      .run();
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(500);
    const wrongKeyEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
      PUBLICATION_ENCRYPTION_KEY_V1:
        "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    };
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
          wrongKeyEnv,
        )
      ).status,
    ).toBe(500);
  });

  it("serializes competing mutations and exposes a deterministic busy response", async () => {
    const artifact = await syncedArtifact();
    await syncRevision(artifact, 2, "<h1>competing second</h1>");
    await env.DB.prepare(
      "UPDATE sync_artifacts SET publication_lease_owner = ?, publication_lease_expires_at = ? WHERE cloud_artifact_id = ?",
    )
      .bind(
        "test-held-lease",
        "2999-01-01T00:00:00.000Z",
        artifact.cloudArtifactId,
      )
      .run();
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(409);
    await env.DB.prepare(
      "UPDATE sync_artifacts SET publication_lease_owner = NULL, publication_lease_expires_at = NULL WHERE cloud_artifact_id = ?",
    )
      .bind(artifact.cloudArtifactId)
      .run();

    const results = await Promise.all([
      api(
        `/api/creator/${artifact.creatorToken}/publish`,
        jsonRequest({ revisionVersion: 1, durationDays: 7 }),
      ),
      api(
        `/api/creator/${artifact.creatorToken}/publish`,
        jsonRequest({ revisionVersion: 2, durationDays: 7 }),
      ),
    ]);
    const statuses = results.map((response) => response.status);
    expect(statuses).toContain(201);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(
      true,
    );
    const committed = await Promise.all(
      results
        .filter((response) => response.status === 201)
        .map(async (response) =>
          publicationSchema.parse(await response.json()),
        ),
    );
    const rows = await env.DB.prepare(
      "SELECT status, revision_version FROM publications WHERE artifact_id = ? ORDER BY created_at ASC",
    )
      .bind(artifact.cloudArtifactId)
      .all<{ status: string; revision_version: number }>();
    expect(rows.results.filter((row) => row.status === "active")).toHaveLength(
      1,
    );
    expect(rows.results).toHaveLength(committed.length);
    const workspace = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(workspace.publication?.revisionVersion).toBe(
      rows.results.find((row) => row.status === "active")?.revision_version,
    );
    if (!workspace.publication)
      throw new Error("active publication is missing");
    expect(committed.map((publication) => publication.id)).toContain(
      workspace.publication.id,
    );
    const activeCommitted = committed.find(
      (publication) => publication.id === workspace.publication?.id,
    );
    if (!activeCommitted?.publicUrl)
      throw new Error("active publication URL is missing");
    expect(
      (
        await api(
          `/api/publications/${activeCommitted.publicUrl.split("/").at(-1)}`,
        )
      ).status,
    ).toBe(200);
  });
});

async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function hexBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function base64Bytes(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
