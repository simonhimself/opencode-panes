import {
  MAX_REMOTE_FILE_BYTES,
  cloudManifestSchema,
  errorEnvelopeSchema,
  syncCreateResponseSchema,
  syncRevisionCommitResponseSchema,
} from "@opencode-panes/contracts";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
