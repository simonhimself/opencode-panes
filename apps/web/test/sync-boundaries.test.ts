import {
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_REVISION_BYTES,
  cloudManifestSchema,
  errorEnvelopeSchema,
  syncCreateResponseSchema,
} from "@opencode-panes/contracts";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { privateRevisionObjectKey } from "../worker/storage";

const ORIGIN = "https://panes.example";
const EXACT_FILE_HASHES = {
  A: "285f1e531d8e7602360a4eb299773983458642ae82e70a2dcc50cfe70699652e",
  B: "2a23cf471be0345f024d36105666c211ad20b071a81a0c4c05ad4bde97051ad6",
  C: "116daa31ce1ba6244af12af06b359c8d9e5e6f3bf518f165b33b962c124964a1",
} as const;

describe("private Sync Worker remote boundaries", () => {
  it("accepts an exact 25 MiB file through commit visibility and retrieval", async () => {
    const artifact = await createArtifact("file-exact", "File exact");
    const file = fileEntry(
      "index.html",
      MAX_REMOTE_FILE_BYTES,
      "text/html",
      EXACT_FILE_HASHES.A,
    );
    const manifest = manifestFor(artifact, "file-exact", "File exact", [file]);

    await seedFile(
      artifact,
      file.path,
      file.byteSize,
      65,
      file.mediaType,
      file.sha256,
    );
    expect(
      (
        await api(
          `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
          jsonRequest({ manifest }, "owner-file-exact"),
        )
      ).status,
    ).toBe(201);

    const response = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/files/index.html`,
      { headers: { Authorization: "Bearer owner-file-exact" } },
    );
    expect(response.status).toBe(200);
    await expectRepeatedResponse(response, file.byteSize, 65);
  });

  it("rejects a 25 MiB plus one byte file", async () => {
    const artifact = await createArtifact("file-overflow", "File overflow");
    const file = fileEntry(
      "index.html",
      MAX_REMOTE_FILE_BYTES + 1,
      "text/html",
      EXACT_FILE_HASHES.B,
    );
    const manifest = manifestFor(artifact, "file-overflow", "File overflow", [
      file,
    ]);
    const response = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
      jsonRequest({ manifest }, "owner-file-overflow"),
    );
    expect(response.status).toBe(413);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe(
      "FILE_TOO_LARGE",
    );
  });

  it("accepts an exact 100 MiB Revision and rejects one byte over before object verification", async () => {
    const artifact = await createArtifact("revision-exact", "Revision exact");
    const paths = ["index.html", "one.bin", "two.bin", "three.bin"];
    const files = paths.map((path) => ({
      kind: "file" as const,
      path,
      sha256: EXACT_FILE_HASHES.C,
      byteSize: MAX_REMOTE_FILE_BYTES,
      mediaType:
        path === "index.html" ? "text/html" : "application/octet-stream",
    }));
    expect(files.reduce((total, file) => total + file.byteSize, 0)).toBe(
      MAX_REMOTE_REVISION_BYTES,
    );
    const manifest = manifestFor(
      artifact,
      "revision-exact",
      "Revision exact",
      files,
    );
    for (const file of files) {
      await seedFile(
        artifact,
        file.path,
        file.byteSize,
        67,
        file.mediaType,
        file.sha256,
      );
    }
    expect(
      (
        await api(
          `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
          jsonRequest({ manifest }, "owner-revision-exact"),
        )
      ).status,
    ).toBe(201);

    const visible = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/files/three.bin`,
      { headers: { Authorization: "Bearer owner-revision-exact" } },
    );
    expect(visible.status).toBe(200);
    await expectRepeatedResponse(visible, MAX_REMOTE_FILE_BYTES, 67);

    const overflowArtifact = await createArtifact(
      "revision-overflow",
      "Revision overflow",
    );
    const overflowFiles = [
      ...files,
      {
        kind: "file" as const,
        path: "overflow.bin",
        sha256: EXACT_FILE_HASHES.C,
        byteSize: 1,
        mediaType: "application/octet-stream",
      },
    ];
    const overflowManifest = manifestFor(
      overflowArtifact,
      "revision-overflow",
      "Revision overflow",
      overflowFiles,
    );
    const overflow = await api(
      `/api/sync/artifacts/${overflowArtifact.cloudArtifactId}/revisions/1/commit`,
      jsonRequest({ manifest: overflowManifest }, "owner-revision-overflow"),
    );
    expect(overflow.status).toBe(413);
    expect(errorEnvelopeSchema.parse(await overflow.json()).error.code).toBe(
      "REVISION_TOO_LARGE",
    );
  });
});

async function createArtifact(slug: string, title: string) {
  const response = await api(
    "/api/sync/artifacts",
    jsonRequest({
      projectId: `project-sync-${slug}`,
      artifactId: `artifact-sync-${slug}`,
      slug: `sync-${slug}`,
      title,
      idempotencyKey: `sync-${slug}-1`,
      ownerCredential: `owner-${slug}`,
      creatorToken: `creator-${slug}`,
    }),
  );
  return syncCreateResponseSchema.parse(await response.json());
}

function fileEntry(
  path: string,
  byteSize: number,
  mediaType: string,
  sha256: string,
) {
  return {
    kind: "file" as const,
    path,
    sha256,
    byteSize,
    mediaType,
  };
}

function manifestFor(
  artifact: { cloudProjectId: string; cloudArtifactId: string },
  slug: string,
  title: string,
  files: Array<ReturnType<typeof fileEntry>>,
) {
  return cloudManifestSchema.parse({
    schemaVersion: 1,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.cloudArtifactId,
    slug: `sync-${slug}`,
    title,
    revisions: [
      {
        id: `revision-${slug}`,
        version: 1,
        preview: { adapter: "browser", entryPath: "index.html" },
        approvedOrigins: [],
        files,
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    ],
  });
}

async function seedFile(
  artifact: { cloudProjectId: string; cloudArtifactId: string },
  path: string,
  byteSize: number,
  value: number,
  mediaType: string,
  sha256: string,
) {
  const key = privateRevisionObjectKey(
    artifact.cloudProjectId,
    artifact.cloudArtifactId,
    `sync_revision_${artifact.cloudArtifactId}_1`,
    path,
  );
  const fixedLength = new FixedLengthStream(byteSize);
  const pipe = repeatedBytes(byteSize, value).pipeTo(fixedLength.writable);
  const put = env.PRIVATE_ARTIFACTS.put(key, fixedLength.readable, {
    httpMetadata: { contentType: mediaType },
    customMetadata: {
      sha256,
      byteSize: String(byteSize),
    },
  });
  await Promise.all([pipe, put]);
}

function jsonRequest(value: unknown, token?: string): RequestInit {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return { method: "POST", headers, body: JSON.stringify(value) };
}

async function api(path: string, init?: RequestInit) {
  return SELF.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function expectRepeatedResponse(
  response: Response,
  byteSize: number,
  value: number,
) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  let count = 0;
  while (true) {
    const chunk = await reader!.read();
    if (chunk.done) break;
    const bytes = chunk.value as Uint8Array;
    expect(bytes.every((byte) => byte === value)).toBe(true);
    count += bytes.byteLength;
  }
  expect(count).toBe(byteSize);
}

function repeatedBytes(
  byteSize: number,
  value: number,
): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(value);
  let remaining = byteSize;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const next = Math.min(remaining, chunk.byteLength);
      controller.enqueue(
        next === chunk.byteLength ? chunk : chunk.slice(0, next),
      );
      remaining -= next;
    },
  });
}
