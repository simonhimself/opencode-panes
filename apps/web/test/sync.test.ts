import {
  MAX_REMOTE_FILE_BYTES,
  cloudManifestSchema,
  errorEnvelopeSchema,
  syncCreateResponseSchema,
  syncRevisionCommitResponseSchema,
} from "@opencode-panes/contracts";
import {
  SELF,
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../worker/index";

const ORIGIN = "https://panes.example";
const PROJECT_ID = "project-sync-test";
const LOCAL_ARTIFACT_ID = "artifact-sync-test";
const OWNER = "owner-credential-sync-test";
const CREATOR = "creator-token-sync-test";

function jsonRequest(
  value: unknown,
  token?: string,
  headers?: HeadersInit,
): RequestInit {
  const result = new Headers({ "Content-Type": "application/json" });
  if (token) result.set("Authorization", `Bearer ${token}`);
  if (headers)
    new Headers(headers).forEach((value, name) => result.set(name, value));
  return { method: "POST", headers: result, body: JSON.stringify(value) };
}

async function api(path: string, init?: RequestInit) {
  return SELF.fetch(new Request(`${ORIGIN}${path}`, init));
}

describe("first private Sync Worker HTTP seam", () => {
  it("reuses valid Creator links, rotates explicitly, and distinguishes 404 from 410", async () => {
    const create = await api(
      "/api/sync/artifacts",
      jsonRequest(
        {
          projectId: "project-creator-lifecycle",
          artifactId: "artifact-creator-lifecycle",
          slug: "creator-lifecycle",
          title: "Creator lifecycle",
          idempotencyKey: "creator-lifecycle-1",
          ownerCredential: "owner-creator-lifecycle",
          creatorToken: "creator-creator-lifecycle",
        },
        undefined,
        { "X-Panes-Sync-Session": "creator-rotation-session" },
      ),
    );
    const first = syncCreateResponseSchema.parse(await create.json());
    const token = first.creatorUrl.split("/").at(-1);
    expect(token).toBe("creator-creator-lifecycle");
    const active = await api(`/api/creator/${token}`);
    expect(active.status).toBe(200);
    expect(active.headers.get("Cache-Control")).toBe("no-store");
    expect(active.headers.get("Referrer-Policy")).toBe("no-referrer");

    const replay = syncCreateResponseSchema.parse(
      await (
        await api(
          "/api/sync/artifacts",
          jsonRequest(
            {
              projectId: "project-creator-lifecycle",
              artifactId: "artifact-creator-lifecycle",
              slug: "creator-lifecycle",
              title: "Creator lifecycle",
              idempotencyKey: "creator-lifecycle-1",
              ownerCredential: "owner-creator-lifecycle",
              creatorToken: "creator-creator-lifecycle",
            },
            undefined,
            { "X-Panes-Sync-Session": "creator-rotation-session" },
          ),
        )
      ).json(),
    );
    expect(replay.creatorExpiresAt).toBe(first.creatorExpiresAt);

    const rotated = await api(
      `/api/sync/artifacts/${first.cloudArtifactId}/creator/rotate`,
      jsonRequest({}, "owner-creator-lifecycle", {
        "X-Panes-Sync-Session": "creator-rotation-session",
      }),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      creatorToken: string;
      creatorExpiresAt: string;
    };
    expect(rotatedBody.creatorToken).not.toBe(token);
    expect(Date.parse(rotatedBody.creatorExpiresAt)).toBeGreaterThan(
      Date.parse(first.creatorExpiresAt),
    );
    expect((await api(`/api/creator/${token}`)).status).toBe(410);
    expect(
      (
        await api(`/api/creator/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(410);
    expect((await api(`/api/creator/${rotatedBody.creatorToken}`)).status).toBe(
      200,
    );
    await env.DB.prepare(
      "UPDATE creator_links SET expires_at = ? WHERE artifact_id = ? AND revoked_at IS NULL",
    )
      .bind("2020-01-01T00:00:00.000Z", first.cloudArtifactId)
      .run();
    expect((await api(`/api/creator/${rotatedBody.creatorToken}`)).status).toBe(
      410,
    );
    expect((await api("/api/creator/unknown-creator-token")).status).toBe(404);
  });

  it("tracks temporary uploads, skips matching retries, and serializes sessions", async () => {
    const create = await api(
      "/api/sync/artifacts",
      jsonRequest(
        {
          projectId: "project-temp-upload",
          artifactId: "artifact-temp-upload",
          slug: "temp-upload",
          title: "Temporary upload",
          idempotencyKey: "temp-upload-1",
          ownerCredential: "owner-temp-upload",
          creatorToken: "creator-temp-upload",
        },
        undefined,
        { "X-Panes-Sync-Session": "session-one" },
      ),
    );
    const artifact = syncCreateResponseSchema.parse(await create.json());
    const bytes = new TextEncoder().encode("temporary");
    const hash = await sha256(bytes);
    const path = `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/files/index.html`;
    expect(
      (
        await uploadFileWithSession(
          path,
          bytes,
          "text/html",
          "owner-temp-upload",
          "session-one",
        )
      ).status,
    ).toBe(204);
    const matching = await api(path, {
      method: "HEAD",
      headers: {
        Authorization: "Bearer owner-temp-upload",
        "Content-Type": "text/html",
        "X-Panes-File-SHA256": hash,
        "X-Panes-File-Byte-Size": String(bytes.byteLength),
        "X-Panes-Sync-Session": "session-one",
      },
    });
    expect(matching.status).toBe(204);
    expect(matching.headers.get("X-Panes-Upload-Verified")).toBe("true");
    expect(
      (
        await uploadFileWithSession(
          path,
          new TextEncoder().encode("different"),
          "text/html",
          "owner-temp-upload",
          "session-one",
        )
      ).status,
    ).toBe(409);
    const blocked = await uploadFileWithSession(
      path,
      bytes,
      "text/html",
      "owner-temp-upload",
      "session-two",
    );
    expect(blocked.status).toBe(409);
  });

  it("runs bounded scheduled cleanup without deleting committed references", async () => {
    const create = await api(
      "/api/sync/artifacts",
      jsonRequest({
        projectId: "project-cleanup",
        artifactId: "artifact-cleanup",
        slug: "cleanup",
        title: "Cleanup",
        idempotencyKey: "cleanup-1",
        ownerCredential: "owner-cleanup",
        creatorToken: "creator-cleanup",
      }),
    );
    const artifact = syncCreateResponseSchema.parse(await create.json());
    const bytes = new TextEncoder().encode("orphan");
    const uploaded = await uploadFile(
      artifact.cloudArtifactId,
      1,
      "index.html",
      bytes,
      "text/html",
      "owner-cleanup",
    );
    expect(uploaded.status).toBe(204);
    const referencedUpload = await uploadFile(
      artifact.cloudArtifactId,
      1,
      "keep.html",
      new TextEncoder().encode("keep"),
      "text/html",
      "owner-cleanup",
    );
    expect(referencedUpload.status).toBe(204);
    const uploadRows = await env.DB.prepare(
      "SELECT path, object_key FROM sync_uploads WHERE artifact_id = ? ORDER BY path",
    )
      .bind(artifact.cloudArtifactId)
      .all<{ path: string; object_key: string }>();
    const keepRow = uploadRows.results.find((row) => row.path === "keep.html");
    const orphanRow = uploadRows.results.find(
      (row) => row.path === "index.html",
    );
    if (!keepRow) throw new Error("expected tracked keep upload");
    if (!orphanRow) throw new Error("expected tracked orphan upload");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO local_revisions
          (id, artifact_id, version, preview_entry, approved_origins,
           created_at, committed_at, cloud_manifest_key)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        "cleanup-committed-revision",
        artifact.cloudArtifactId,
        JSON.stringify({ adapter: "browser", entryPath: "keep.html" }),
        "[]",
        "2020-01-01T00:00:00.000Z",
        "2020-01-01T00:00:00.000Z",
        "private/manifests/cleanup.json",
      ),
      env.DB.prepare(
        `INSERT INTO revision_files
          (revision_id, path, sha256, byte_size, media_type, object_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        "cleanup-committed-revision",
        "keep.html",
        await sha256(new TextEncoder().encode("keep")),
        4,
        "text/html",
        keepRow.object_key,
      ),
      env.DB.prepare(
        "UPDATE sync_uploads SET created_at = ? WHERE artifact_id = ?",
      ).bind("2020-01-01T00:00:00.000Z", artifact.cloudArtifactId),
    ]);
    const executionContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.parse("2026-08-29T12:00:00.000Z"),
      }),
      env,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    const row = await env.DB.prepare(
      "SELECT object_key FROM sync_uploads WHERE artifact_id = ? AND path = ?",
    )
      .bind(artifact.cloudArtifactId, "index.html")
      .first<{ object_key: string }>();
    expect(row).toBeNull();
    expect(await env.PRIVATE_ARTIFACTS.head(orphanRow.object_key)).toBeNull();
    const kept = await env.DB.prepare(
      "SELECT object_key FROM sync_uploads WHERE artifact_id = ? AND path = ?",
    )
      .bind(artifact.cloudArtifactId, "keep.html")
      .first<{ object_key: string }>();
    expect(kept?.object_key).toBe(keepRow.object_key);
    expect(await env.PRIVATE_ARTIFACTS.head(keepRow.object_key)).not.toBeNull();
  });

  it("commits complete history one Revision at a time and retrieves each committed Revision", async () => {
    const create = await api(
      "/api/sync/artifacts",
      jsonRequest({
        projectId: "project-sync-history",
        artifactId: "artifact-sync-history",
        slug: "sync-history",
        title: "Sync history",
        idempotencyKey: "sync-history-1",
        ownerCredential: "owner-credential-history",
        creatorToken: "creator-token-history",
      }),
    );
    const artifact = syncCreateResponseSchema.parse(await create.json());
    const v1 = new TextEncoder().encode("v1\r\n");
    const v2 = Uint8Array.from([0, 255, 1, 254]);
    const revision = (version: number, bytes: Uint8Array) => ({
      id: `revision-local-${version}`,
      version,
      preview: { adapter: "browser" as const, entryPath: "index.html" },
      approvedOrigins: [],
      files: [
        {
          kind: "file" as const,
          path: "index.html",
          sha256: "pending",
          byteSize: bytes.byteLength,
          mediaType: "application/octet-stream",
        },
      ],
      createdAt: "2026-08-29T12:00:00.000Z",
    });
    const firstRevision = revision(1, v1);
    firstRevision.files[0]!.sha256 = await sha256(v1);
    const firstManifest = cloudManifestSchema.parse({
      schemaVersion: 1,
      projectId: artifact.cloudProjectId,
      artifactId: artifact.cloudArtifactId,
      slug: "sync-history",
      title: "Sync history",
      revisions: [firstRevision],
    });
    await uploadFile(
      artifact.cloudArtifactId,
      1,
      "index.html",
      v1,
      "application/octet-stream",
      "owner-credential-history",
    );
    expect(
      (
        await api(
          `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
          jsonRequest({ manifest: firstManifest }, "owner-credential-history"),
        )
      ).status,
    ).toBe(201);

    const secondRevision = revision(2, v2);
    secondRevision.files[0]!.sha256 = await sha256(v2);
    const secondManifest = cloudManifestSchema.parse({
      ...firstManifest,
      revisions: [firstRevision, secondRevision],
    });
    await uploadFile(
      artifact.cloudArtifactId,
      2,
      "index.html",
      v2,
      "application/octet-stream",
      "owner-credential-history",
    );
    expect(
      (
        await api(
          `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/2/commit`,
          jsonRequest({ manifest: secondManifest }, "owner-credential-history"),
        )
      ).status,
    ).toBe(201);

    for (const [version, expected] of [
      [1, v1],
      [2, v2],
    ] as const) {
      const response = await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/${version}/files/index.html`,
        { headers: { Authorization: "Bearer owner-credential-history" } },
      );
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    }
  });

  it("creates one idempotent cloud Artifact and commits exact files privately", async () => {
    const createRequest = {
      projectId: PROJECT_ID,
      artifactId: LOCAL_ARTIFACT_ID,
      slug: "sync-test",
      title: "Sync test",
      idempotencyKey: "sync-idempotency-1",
      ownerCredential: OWNER,
      creatorToken: CREATOR,
    };
    const firstResponse = await api(
      "/api/sync/artifacts",
      jsonRequest(createRequest),
    );
    expect(firstResponse.status).toBe(201);
    const first = syncCreateResponseSchema.parse(await firstResponse.json());

    const replayResponse = await api(
      "/api/sync/artifacts",
      jsonRequest(createRequest),
    );
    expect(replayResponse.status).toBe(200);
    const replay = syncCreateResponseSchema.parse(await replayResponse.json());
    expect(replay.cloudArtifactId).toBe(first.cloudArtifactId);
    expect(replay.creatorUrl).toBe(first.creatorUrl);

    const text = new TextEncoder().encode("line one\r\nline two\n");
    const binary = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    const revision = {
      id: "revision-local-1",
      version: 1,
      preview: { adapter: "browser", entryPath: "index.html" },
      approvedOrigins: [],
      files: [
        {
          kind: "file" as const,
          path: "index.html",
          sha256: await sha256(text),
          byteSize: text.byteLength,
          mediaType: "text/html",
        },
        {
          kind: "file" as const,
          path: "assets/data.bin",
          sha256: await sha256(binary),
          byteSize: binary.byteLength,
          mediaType: "application/octet-stream",
        },
      ],
      createdAt: "2026-08-29T12:00:00.000Z",
    };
    const manifest = cloudManifestSchema.parse({
      schemaVersion: 1,
      projectId: first.cloudProjectId,
      artifactId: first.cloudArtifactId,
      slug: "sync-test",
      title: "Sync test",
      revisions: [revision],
    });

    for (const [path, bytes, mediaType] of [
      ["index.html", text, "text/html"],
      ["assets/data.bin", binary, "application/octet-stream"],
    ] as const) {
      const response = await api(
        `/api/sync/artifacts/${first.cloudArtifactId}/revisions/1/files/${encodeURIComponent(path)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${OWNER}`,
            "Content-Type": mediaType,
            "X-Panes-File-SHA256": await sha256(bytes),
            "X-Panes-File-Byte-Size": String(bytes.byteLength),
          },
          body: bytes,
        },
      );
      expect(response.status).toBe(204);
    }

    const hidden = await api(
      `/api/sync/artifacts/${first.cloudArtifactId}/revisions/1/files/index.html`,
      { headers: { Authorization: `Bearer ${OWNER}` } },
    );
    expect(hidden.status).toBe(404);

    const commit = await api(
      `/api/sync/artifacts/${first.cloudArtifactId}/revisions/1/commit`,
      jsonRequest({ manifest }, OWNER),
    );
    expect(commit.status).toBe(201);
    expect(
      syncRevisionCommitResponseSchema.parse(await commit.json()).version,
    ).toBe(1);

    const committed = await api(
      `/api/sync/artifacts/${first.cloudArtifactId}/revisions/1/files/index.html`,
      { headers: { Authorization: `Bearer ${OWNER}` } },
    );
    expect(committed.status).toBe(200);
    expect(new Uint8Array(await committed.arrayBuffer())).toEqual(text);

    const conflictingManifest = structuredClone(manifest);
    const conflictingFile = conflictingManifest.revisions[0]?.files[0];
    if (!conflictingFile || conflictingFile.kind !== "file") {
      throw new Error("test manifest is missing its expected file");
    }
    conflictingFile.sha256 = "a".repeat(64);
    const conflict = await api(
      `/api/sync/artifacts/${first.cloudArtifactId}/revisions/1/commit`,
      jsonRequest({ manifest: conflictingManifest }, OWNER),
    );
    expect(conflict.status).toBe(409);

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM local_revisions WHERE artifact_id = ? AND committed_at IS NOT NULL",
    )
      .bind(first.cloudArtifactId)
      .first<{ count: number }>();
    expect(stored?.count).toBe(1);
    const publications = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM shares WHERE artifact_id = ?",
    )
      .bind(first.cloudArtifactId)
      .first<{ count: number }>();
    expect(publications?.count).toBe(0);
  });

  it("rejects mandatory exclusions and oversized files before visibility", async () => {
    const create = await api(
      "/api/sync/artifacts",
      jsonRequest({
        projectId: "project-sync-limits",
        artifactId: "artifact-sync-limits",
        slug: "sync-limits",
        title: "Sync limits",
        idempotencyKey: "sync-limits-1",
        ownerCredential: "owner-credential-limits",
        creatorToken: "creator-token-limits",
      }),
    );
    const artifact = syncCreateResponseSchema.parse(await create.json());
    const bytes = new Uint8Array([1, 2, 3]);
    const upload = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/files/.env`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer owner-credential-limits",
          "Content-Type": "text/plain",
          "X-Panes-File-SHA256": await sha256(bytes),
          "X-Panes-File-Byte-Size": String(bytes.byteLength),
        },
        body: bytes,
      },
    );
    expect(upload.status).toBe(422);

    const excludedCommit = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
      jsonRequest(
        {
          manifest: {
            schemaVersion: 1,
            projectId: artifact.cloudProjectId,
            artifactId: artifact.cloudArtifactId,
            slug: "sync-limits",
            title: "Sync limits",
            revisions: [
              {
                id: "revision-local-limits",
                version: 1,
                preview: { adapter: "browser", entryPath: ".env" },
                approvedOrigins: [],
                files: [
                  {
                    kind: "file",
                    path: ".env",
                    sha256: await sha256(bytes),
                    byteSize: bytes.byteLength,
                    mediaType: "text/plain",
                  },
                ],
                createdAt: "2026-08-29T12:00:00.000Z",
              },
            ],
          },
        },
        "owner-credential-limits",
      ),
    );
    expect(excludedCommit.status).toBe(422);
    expect(
      errorEnvelopeSchema.parse(await excludedCommit.json()).error.code,
    ).toBe("VALIDATION_ERROR");

    const tooLarge = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/2/files/large.bin`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer owner-credential-limits",
          "Content-Type": "application/octet-stream",
          "X-Panes-File-SHA256": "a".repeat(64),
          "X-Panes-File-Byte-Size": String(MAX_REMOTE_FILE_BYTES + 1),
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_REMOTE_FILE_BYTES + 1));
            controller.close();
          },
        }),
      },
    );
    expect(tooLarge.status).toBe(413);
  });

  it("rejects a Preview entry that is not present in uploaded files", async () => {
    const create = await api(
      "/api/sync/artifacts",
      jsonRequest({
        projectId: "project-sync-preview",
        artifactId: "artifact-sync-preview",
        slug: "sync-preview",
        title: "Sync Preview",
        idempotencyKey: "sync-preview-1",
        ownerCredential: "owner-credential-preview",
        creatorToken: "creator-token-preview",
      }),
    );
    const artifact = syncCreateResponseSchema.parse(await create.json());
    const commit = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
      jsonRequest(
        {
          manifest: {
            schemaVersion: 1,
            projectId: artifact.cloudProjectId,
            artifactId: artifact.cloudArtifactId,
            slug: "sync-preview",
            title: "Sync Preview",
            revisions: [
              {
                id: "revision-local-preview",
                version: 1,
                preview: { adapter: "browser", entryPath: "index.html" },
                approvedOrigins: [],
                files: [],
                createdAt: "2026-08-29T12:00:00.000Z",
              },
            ],
          },
        },
        "owner-credential-preview",
      ),
    );
    expect(commit.status).toBe(422);
    expect(errorEnvelopeSchema.parse(await commit.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });
});

async function uploadFile(
  artifactId: string,
  version: number,
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  token: string,
) {
  return api(
    `/api/sync/artifacts/${artifactId}/revisions/${version}/files/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mediaType,
        "X-Panes-File-SHA256": await sha256(bytes),
        "X-Panes-File-Byte-Size": String(bytes.byteLength),
      },
      body: bytes.buffer as ArrayBuffer,
    },
  );
}

async function uploadFileWithSession(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  token: string,
  session: string,
) {
  return api(path, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mediaType,
      "X-Panes-File-SHA256": await sha256(bytes),
      "X-Panes-File-Byte-Size": String(bytes.byteLength),
      "X-Panes-Sync-Session": session,
    },
    body: bytes.buffer as ArrayBuffer,
  });
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
