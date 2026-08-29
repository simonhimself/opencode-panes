import {
  cloudManifestSchema,
  syncCreateResponseSchema,
} from "@opencode-panes/contracts";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decryptPublicationToken } from "../worker/publication";

const ORIGIN = "https://panes.example";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_REVISION_BYTES = 100 * 1024 * 1024;
const MAX_TEST_STREAM_CHUNK = 256 * 1024;
const LARGE_FILE_FIXTURES = [
  {
    path: "parts/zero.bin",
    value: 0,
    sha256: "394c345f0b0c63ee652627a62eed069244d35c4d5134e4f07d4eabb51afda47e",
    crc32: 0x72103906,
  },
  {
    path: "parts/one.bin",
    value: 1,
    sha256: "d7ce787fcdbc8fbb62ab0f5c877ff3b80908b14f61cefd5cf2cbeece4d4c68e6",
    crc32: 0xeffd8a12,
  },
  {
    path: "parts/two.bin",
    value: 2,
    sha256: "d2bf9669b6de508b22f446da3b42f98407ee6ce88066ec2944ddc7d787a4a784",
    crc32: 0x92ba596f,
  },
  {
    path: "parts/three.bin",
    value: 3,
    sha256: "37beae894fa005b69a64c574be31b9838cf024a3779ecb389c4b72bdc9f73673",
    crc32: 0x0f57ea7b,
  },
] as const;

describe("safe Revision ZIP downloads", () => {
  it("streams exact selected Revision bytes, directories, and portable modes", async () => {
    const artifact = await createSyncedArtifact();
    const v1Files = [
      file(
        "index.html",
        bytes("\uFEFFline one\r\nline two\r\n"),
        "text/html",
        0o755,
      ),
      file(
        "assets/data.bin",
        Uint8Array.from([0, 255, 1, 254]),
        "application/octet-stream",
      ),
      file("empty.txt", new Uint8Array(), "text/plain"),
      directory("empty-dir", 0o700),
    ];
    const v2Files = [file("index.html", bytes("later"), "text/html")];
    await commitRevision(artifact, 1, v1Files, "index.html");
    await commitRevision(artifact, 2, v2Files, "index.html");

    const creator = await api(
      `/api/creator/${artifact.creatorToken}/revisions/1/download.zip`,
    );
    expect(creator.status).toBe(200);
    expect(creator.headers.get("Content-Type")).toBe("application/zip");
    expect(creator.headers.get("Cache-Control")).toBe("no-store");
    expect(creator.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(creator.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(creator.headers.get("Content-Disposition")).toBe(
      'attachment; filename="zip-fixture-v1.zip"',
    );
    const archiveBytes = await creator.arrayBuffer();
    const archive = parseZip(archiveBytes);
    expect(archive.entries.map((entry) => entry.name)).toEqual([
      "index.html",
      "assets/data.bin",
      "empty.txt",
      "empty-dir/",
    ]);
    expect(
      archive.entries.find((entry) => entry.name === "index.html")?.bytes,
    ).toEqual(bytes("\uFEFFline one\r\nline two\r\n"));
    expect(
      archive.entries.find((entry) => entry.name === "assets/data.bin")?.bytes,
    ).toEqual(Uint8Array.from([0, 255, 1, 254]));
    expect(
      archive.entries.find((entry) => entry.name === "empty.txt")?.bytes,
    ).toEqual(new Uint8Array());
    expect(
      archive.entries.find((entry) => entry.name === "empty-dir/")?.bytes,
    ).toEqual(new Uint8Array());
    expect(
      archive.entries.find((entry) => entry.name === "index.html")?.mode,
    ).toBe(0o100755);
    expect(
      archive.entries.find((entry) => entry.name === "empty-dir/")?.mode,
    ).toBe(0o040700);
    const storedFiles = await env.DB.prepare(
      "SELECT object_key FROM revision_files WHERE revision_id IN (?, ?)",
    )
      .bind(
        `sync_revision_${artifact.artifactId}_1`,
        `sync_revision_${artifact.artifactId}_2`,
      )
      .all<{ object_key: string }>();
    assertArchiveDoesNotContain(new Uint8Array(archiveBytes), [
      "artifact.json",
      `private/manifests/${hex(artifact.projectId)}/${hex(artifact.artifactId)}/v1.json`,
      `private/manifests/${hex(artifact.projectId)}/${hex(artifact.artifactId)}/v2.json`,
      ...storedFiles.results.map((row) => row.object_key),
      artifact.projectId,
      artifact.artifactId,
      artifact.ownerCredential,
      artifact.creatorToken,
      "sha256",
      "byteSize",
      "sessionId",
      "reconnect",
      "publication",
      "expiresAt",
      "cloud_manifest_key",
      "private/",
    ]);
  });

  it("lets Creator select v2 while public download stays pinned to v1", async () => {
    const artifact = await createSyncedArtifact();
    const v1 = [file("index.html", bytes("public v1"), "text/html")];
    const v2 = [file("index.html", bytes("private v2"), "text/html")];
    await commitRevision(artifact, 1, v1, "index.html");
    await commitRevision(artifact, 2, v2, "index.html");
    const creatorV2 = await api(
      `/api/creator/${artifact.creatorToken}/revisions/2/download.zip`,
    );
    expect(parseZip(await creatorV2.arrayBuffer()).entries[0]?.bytes).toEqual(
      bytes("private v2"),
    );

    const publication = await api(
      `/api/creator/${artifact.creatorToken}/publish`,
      jsonRequest({ revisionVersion: 1, durationDays: 7 }),
    );
    const publicationBody = (await publication.json()) as {
      id: string;
      publicUrl?: string;
    };
    expect(publication.status).toBe(201);
    expect(publicationBody.publicUrl).toBeUndefined();
    const publicToken = await storedPublicationToken(
      artifact.artifactId,
      publicationBody.id,
    );
    const publicV1 = await api(
      `/api/publications/${publicToken}/download.zip?version=2`,
    );
    expect(publicV1.status).toBe(200);
    const publicArchiveBytes = await publicV1.arrayBuffer();
    const publicArchive = parseZip(publicArchiveBytes);
    expect(publicArchive.entries.map((entry) => entry.name)).toEqual([
      "index.html",
    ]);
    expect(publicArchive.entries[0]?.bytes).toEqual(bytes("public v1"));
    const storedFiles = await env.DB.prepare(
      "SELECT object_key FROM revision_files WHERE revision_id IN (?, ?)",
    )
      .bind(
        `sync_revision_${artifact.artifactId}_1`,
        `sync_revision_${artifact.artifactId}_2`,
      )
      .all<{ object_key: string }>();
    assertArchiveDoesNotContain(new Uint8Array(publicArchiveBytes), [
      "artifact.json",
      `private/manifests/${hex(artifact.projectId)}/${hex(artifact.artifactId)}/v1.json`,
      `private/manifests/${hex(artifact.projectId)}/${hex(artifact.artifactId)}/v2.json`,
      ...storedFiles.results.map((row) => row.object_key),
      artifact.projectId,
      artifact.artifactId,
      artifact.ownerCredential,
      artifact.creatorToken,
      publicToken ?? "",
      "private v2",
      "sha256",
      "byteSize",
      "sessionId",
      "reconnect",
      "publication",
      "expiresAt",
      "cloud_manifest_key",
      "private/",
    ]);
  });

  it("streams an exactly 100 MiB Revision without accumulating the archive", async () => {
    const artifact = await createSyncedArtifact();
    await commitStreamedRevision(artifact, LARGE_FILE_FIXTURES);

    const response = await api(
      `/api/creator/${artifact.creatorToken}/revisions/1/download.zip`,
    );
    expect(response.status).toBe(200);
    const contentLength = Number(response.headers.get("Content-Length"));
    expect(contentLength).toBe(expectedZipLength(LARGE_FILE_FIXTURES));

    const result = await consumeStoredZip(response, LARGE_FILE_FIXTURES);
    expect(result.totalBytes).toBe(contentLength);
    expect(result.totalStoredBytes).toBe(MAX_REVISION_BYTES);
    expect(result.maxChunkBytes).toBeLessThanOrEqual(MAX_TEST_STREAM_CHUNK);
  }, 30_000);

  it.each([
    ["../escape.txt", 404],
    ["nested//file.txt", 404],
    ["nested/./file.txt", 404],
    ["nested\\file.txt", 404],
    ["/absolute.txt", 404],
    ["CON.txt", 404],
    ["duplicate.txt", 404],
    ["DUPLICATE.TXT", 404],
    ["cafe\u0301.txt", 404],
    ["folder/file.txt", 404],
    ["trailing-dot.", 404],
    ["trailing-space ", 404],
    ["AUX.txt", 404],
    ["a".repeat(1025), 404],
    ["é".repeat(40000), 404],
  ] as const)(
    "fails closed for unsafe archive path %s",
    async (path, status) => {
      const artifact = await createSyncedArtifact();
      const good = [file("index.html", bytes("good"), "text/html")];
      await commitRevision(artifact, 1, good, "index.html");
      const manifestKey = `private/manifests/${hex(artifact.projectId)}/${hex(artifact.artifactId)}/v1.json`;
      const stored = await env.PRIVATE_ARTIFACTS.get(manifestKey);
      if (!stored) throw new Error("manifest fixture is missing");
      const manifest = (await stored.json()) as Record<string, unknown>;
      const revisions = manifest.revisions as Array<Record<string, unknown>>;
      const revision = revisions[0];
      if (!revision) throw new Error("revision fixture is missing");
      revision.files = [
        {
          kind: "file",
          path,
          sha256: await sha256(bytes("good")),
          byteSize: 4,
          mediaType: "text/html",
        },
        ...(path === "duplicate.txt"
          ? [
              {
                kind: "file" as const,
                path,
                sha256: await sha256(bytes("good")),
                byteSize: 4,
                mediaType: "text/html",
              },
            ]
          : []),
        ...(path === "DUPLICATE.TXT"
          ? [
              {
                kind: "file" as const,
                path: "duplicate.txt",
                sha256: await sha256(bytes("good")),
                byteSize: 4,
                mediaType: "text/html",
              },
            ]
          : []),
        ...(path === "cafe\u0301.txt"
          ? [
              {
                kind: "file" as const,
                path: "café.txt",
                sha256: await sha256(bytes("good")),
                byteSize: 4,
                mediaType: "text/html",
              },
            ]
          : []),
        ...(path === "folder/file.txt"
          ? [
              {
                kind: "file" as const,
                path: "folder",
                sha256: await sha256(bytes("good")),
                byteSize: 4,
                mediaType: "text/html",
              },
            ]
          : []),
      ];
      await env.PRIVATE_ARTIFACTS.put(manifestKey, JSON.stringify(manifest));
      const response = await api(
        `/api/creator/${artifact.creatorToken}/revisions/1/download.zip`,
      );
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(path);
    },
  );

  it("returns 404 and 410 without exposing capability state", async () => {
    expect(
      (await api("/api/creator/unknown/revisions/1/download.zip")).status,
    ).toBe(404);
    const artifact = await createSyncedArtifact();
    await commitRevision(
      artifact,
      1,
      [file("index.html", bytes("x"), "text/html")],
      "index.html",
    );
    await env.DB.prepare(
      "UPDATE creator_links SET expires_at = ? WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", artifact.artifactId)
      .run();
    const expired = await api(
      `/api/creator/${artifact.creatorToken}/revisions/1/download.zip`,
    );
    expect(expired.status).toBe(410);
    expect(await expired.text()).not.toContain(artifact.creatorToken);
  });

  it("fails the already-open stream on an R2 body mismatch", async () => {
    const artifact = await createSyncedArtifact();
    const expected = bytes("expected bytes");
    await commitRevision(
      artifact,
      1,
      [file("index.html", expected, "text/html")],
      "index.html",
    );
    const row = await env.DB.prepare(
      "SELECT object_key, sha256, byte_size FROM revision_files WHERE revision_id = ?",
    )
      .bind(`sync_revision_${artifact.artifactId}_1`)
      .first<{ object_key: string; sha256: string; byte_size: number }>();
    if (!row) throw new Error("file row is missing");
    await env.PRIVATE_ARTIFACTS.put(row.object_key, bytes("tampered bytes"), {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { sha256: row.sha256, byteSize: String(row.byte_size) },
    });
    const response = await api(
      `/api/creator/${artifact.creatorToken}/revisions/1/download.zip`,
    );
    expect(response.status).toBe(200);
    // Headers may already be sent. A body error is the fail-closed outcome.
    const expectedStreamError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(consumeToFailure(response)).rejects.toThrow();
    } finally {
      expectedStreamError.mockRestore();
    }
  });
});

interface FixtureArtifact {
  projectId: string;
  artifactId: string;
  cloudProjectId: string;
  creatorToken: string;
  ownerCredential: string;
  slug: string;
}

interface FixtureFile {
  kind: "file" | "directory";
  path: string;
  mode?: number;
  bytes: Uint8Array;
  sha256?: string;
  byteSize?: number;
  mediaType?: string;
}

interface StreamedFixtureFile {
  path: string;
  value: number;
  sha256: string;
  crc32: number;
}

function file(
  path: string,
  value: Uint8Array,
  mediaType: string,
  mode?: number,
): FixtureFile {
  return {
    kind: "file",
    path,
    bytes: value,
    mediaType,
    ...(mode === undefined ? {} : { mode }),
  };
}

function directory(path: string, mode?: number): FixtureFile {
  return {
    kind: "directory",
    path,
    bytes: new Uint8Array(),
    ...(mode === undefined ? {} : { mode }),
  };
}

async function createSyncedArtifact(): Promise<FixtureArtifact> {
  const projectId = `zip-project-${crypto.randomUUID()}`;
  const artifactId = `zip-artifact-${crypto.randomUUID()}`;
  const slug = "zip-fixture";
  const ownerCredential = `zip-owner-${crypto.randomUUID()}`;
  const response = await api(
    "/api/sync/artifacts",
    jsonRequest({
      projectId,
      artifactId,
      slug,
      title: "ZIP Fixture",
      idempotencyKey: crypto.randomUUID(),
      ownerCredential,
      creatorToken: `zip-creator-${crypto.randomUUID()}`,
    }),
  );
  const created = syncCreateResponseSchema.parse(await response.json());
  return {
    projectId: created.cloudProjectId,
    artifactId: created.cloudArtifactId,
    cloudProjectId: created.cloudProjectId,
    creatorToken: created.creatorUrl.split("/").at(-1)!,
    ownerCredential,
    slug,
  };
}

async function commitRevision(
  artifact: FixtureArtifact,
  version: number,
  inputFiles: FixtureFile[],
  entryPath: string,
): Promise<void> {
  const files = await Promise.all(
    inputFiles.map(async (input) =>
      input.kind === "directory"
        ? {
            kind: "directory" as const,
            path: input.path,
            byteSize: 0,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
          }
        : {
            kind: "file" as const,
            path: input.path,
            sha256: await sha256(input.bytes),
            byteSize: input.bytes.byteLength,
            mediaType: input.mediaType ?? "application/octet-stream",
            ...(input.mode === undefined ? {} : { mode: input.mode }),
          },
    ),
  );
  const prior = [];
  for (let previous = 1; previous < version; previous += 1) {
    const manifestKey = `private/manifests/${hex(artifact.cloudProjectId)}/${hex(artifact.artifactId)}/v${previous}.json`;
    const object = await env.PRIVATE_ARTIFACTS.get(manifestKey);
    if (!object) throw new Error("prior manifest is missing");
    const priorManifest = cloudManifestSchema.parse(await object.json());
    const revision = priorManifest.revisions.at(-1);
    if (revision) prior.push(revision);
  }
  const revision = {
    id: `zip-revision-${artifact.artifactId}-${version}`,
    version,
    preview: { adapter: "browser" as const, entryPath },
    approvedOrigins: [],
    files,
    createdAt: "2026-08-29T12:00:00.000Z",
  };
  const manifest = cloudManifestSchema.parse({
    schemaVersion: 1,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.artifactId,
    slug: artifact.slug,
    title: "ZIP Fixture",
    revisions: [...prior, revision],
  });
  for (const input of inputFiles) {
    if (input.kind !== "file") continue;
    const metadata = files.find(
      (candidate) => candidate.kind === "file" && candidate.path === input.path,
    );
    if (!metadata || metadata.kind !== "file")
      throw new Error("file metadata is missing");
    const upload = await api(
      `/api/sync/artifacts/${artifact.artifactId}/revisions/${version}/files/${encodePath(input.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${artifact.ownerCredential}`,
          "Content-Type": metadata.mediaType,
          "X-Panes-File-SHA256": metadata.sha256,
          "X-Panes-File-Byte-Size": String(metadata.byteSize),
        },
        body: input.bytes.buffer as ArrayBuffer,
      },
    );
    if (upload.status !== 204)
      throw new Error(`fixture upload failed: ${upload.status}`);
  }
  const commit = await api(
    `/api/sync/artifacts/${artifact.artifactId}/revisions/${version}/commit`,
    jsonRequest({ manifest }, artifact.ownerCredential),
  );
  if (commit.status !== 201)
    throw new Error(`fixture commit failed: ${commit.status}`);
}

async function commitStreamedRevision(
  artifact: FixtureArtifact,
  inputFiles: readonly StreamedFixtureFile[],
): Promise<void> {
  const revision = {
    id: `zip-revision-${artifact.artifactId}-1`,
    version: 1,
    preview: { adapter: "browser" as const, entryPath: inputFiles[0]!.path },
    approvedOrigins: [],
    files: inputFiles.map((input) => ({
      kind: "file" as const,
      path: input.path,
      sha256: input.sha256,
      byteSize: MAX_FILE_BYTES,
      mediaType: "application/octet-stream",
    })),
    createdAt: "2026-08-29T12:00:00.000Z",
  };
  const manifest = cloudManifestSchema.parse({
    schemaVersion: 1,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.artifactId,
    slug: artifact.slug,
    title: "ZIP Fixture",
    revisions: [revision],
  });
  for (const input of inputFiles) {
    const upload = await api(
      `/api/sync/artifacts/${artifact.artifactId}/revisions/1/files/${encodePath(input.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${artifact.ownerCredential}`,
          "Content-Type": "application/octet-stream",
          "X-Panes-File-SHA256": input.sha256,
          "X-Panes-File-Byte-Size": String(MAX_FILE_BYTES),
        },
        body: repeatedBytes(MAX_FILE_BYTES, input.value),
      },
    );
    if (upload.status !== 204)
      throw new Error(`streamed fixture upload failed: ${upload.status}`);
  }
  const commit = await api(
    `/api/sync/artifacts/${artifact.artifactId}/revisions/1/commit`,
    jsonRequest({ manifest }, artifact.ownerCredential),
  );
  if (commit.status !== 201)
    throw new Error(`streamed fixture commit failed: ${commit.status}`);
}

function expectedZipLength(
  files: readonly Pick<StreamedFixtureFile, "path">[],
): number {
  const nameBytes = files.map(
    (file) => new TextEncoder().encode(file.path).byteLength,
  );
  return (
    files.reduce(
      (total, _file, index) =>
        total + 30 + nameBytes[index]! + MAX_FILE_BYTES + 16,
      0,
    ) +
    nameBytes.reduce((total, length) => total + 46 + length, 0) +
    22
  );
}

function repeatedBytes(
  byteSize: number,
  value: number,
): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(MAX_TEST_STREAM_CHUNK).fill(value);
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

function parseZip(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  const view = new DataView(value);
  const eocd = findEocd(bytes, view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== count ||
    count === 0xffff ||
    eocd + 22 + commentLength !== bytes.byteLength ||
    centralOffset + centralSize !== eocd
  )
    throw new Error("ZIP EOCD bounds or disk fields are invalid");

  const entries: Array<{ name: string; bytes: Uint8Array; mode: number }> = [];
  let centralCursor = centralOffset;
  let dataCursor = 0;
  for (let index = 0; index < count; index += 1) {
    assertRange(bytes, centralCursor, 46);
    if (view.getUint32(centralCursor, true) !== 0x02014b50)
      throw new Error("ZIP central record is invalid");
    const madeBy = view.getUint16(centralCursor + 4, true);
    const versionNeeded = view.getUint16(centralCursor + 6, true);
    const flags = view.getUint16(centralCursor + 8, true);
    const method = view.getUint16(centralCursor + 10, true);
    const crc = view.getUint32(centralCursor + 16, true);
    const compressedSize = view.getUint32(centralCursor + 20, true);
    const size = view.getUint32(centralCursor + 24, true);
    const nameLength = view.getUint16(centralCursor + 28, true);
    const extraLength = view.getUint16(centralCursor + 30, true);
    const commentLength = view.getUint16(centralCursor + 32, true);
    const externalAttributes = view.getUint32(centralCursor + 38, true);
    const localOffset = view.getUint32(centralCursor + 42, true);
    const centralLength = 46 + nameLength + extraLength + commentLength;
    assertRange(bytes, centralCursor, centralLength);
    if (
      madeBy >>> 8 !== 3 ||
      versionNeeded !== 20 ||
      (flags !== 0x808 && flags !== 0x800) ||
      method !== 0 ||
      compressedSize !== size ||
      extraLength !== 0 ||
      commentLength !== 0
    )
      throw new Error("ZIP central attributes are invalid");
    if (localOffset !== dataCursor)
      throw new Error("ZIP local offsets are not sequential");
    const name = decodeZipName(
      bytes.slice(centralCursor + 46, centralCursor + 46 + nameLength),
      flags,
    );
    const isDirectory = flags === 0x800;
    if ((externalAttributes & 0x10) !== (isDirectory ? 0x10 : 0))
      throw new Error("ZIP directory attribute is invalid");
    const mode = externalAttributes >>> 16;
    if (mode !== (isDirectory ? 0o040000 : 0o100000) + (mode & 0o7777))
      throw new Error("ZIP UNIX mode type is invalid");

    assertRange(bytes, localOffset, 30);
    if (view.getUint32(localOffset, true) !== 0x04034b50)
      throw new Error("ZIP local record is invalid");
    const localVersion = view.getUint16(localOffset + 4, true);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (
      localVersion !== 20 ||
      localFlags !== flags ||
      localMethod !== 0 ||
      localExtraLength !== 0 ||
      localNameLength !== nameLength ||
      localCrc !== 0 ||
      localCompressedSize !== 0 ||
      localSize !== 0
    )
      throw new Error("ZIP local attributes are invalid");
    const localName = decodeZipName(
      bytes.slice(localOffset + 30, localOffset + 30 + localNameLength),
      localFlags,
    );
    if (localName !== name)
      throw new Error("ZIP local and central names differ");
    const bodyStart = localOffset + 30 + localNameLength;
    assertRange(bytes, bodyStart, size);
    const body = bytes.slice(bodyStart, bodyStart + size);
    const descriptorStart = bodyStart + size;
    if (isDirectory) {
      if (size !== 0 || !name.endsWith("/"))
        throw new Error("ZIP directory body is invalid");
    } else {
      assertRange(bytes, descriptorStart, 16);
      if (
        view.getUint32(descriptorStart, true) !== 0x08074b50 ||
        view.getUint32(descriptorStart + 4, true) !== crc ||
        view.getUint32(descriptorStart + 8, true) !== size ||
        view.getUint32(descriptorStart + 12, true) !== size ||
        crc32(body) !== crc
      )
        throw new Error("ZIP data descriptor or CRC is invalid");
    }
    dataCursor = descriptorStart + (isDirectory ? 0 : 16);
    entries.push({ name, bytes: body, mode });
    centralCursor += centralLength;
  }
  if (
    centralCursor !== centralOffset + centralSize ||
    dataCursor !== centralOffset
  )
    throw new Error("ZIP central directory length is invalid");
  return { entries };
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  if (bytes.byteLength < 22) throw new Error("ZIP is shorter than its EOCD");
  const first = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end record is missing");
}

function assertRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  )
    throw new Error("ZIP record exceeds archive bounds");
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x800) === 0)
    throw new Error("ZIP entry name is not marked as UTF-8");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): readonly number[] {
  const table: number[] = [];
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table.push(crc >>> 0);
  }
  return table;
}

async function consumeStoredZip(
  response: Response,
  files: readonly StreamedFixtureFile[],
): Promise<{
  totalBytes: number;
  totalStoredBytes: number;
  maxChunkBytes: number;
}> {
  if (!response.body) throw new Error("ZIP response body is missing");
  const cursor = new StreamCursor(response.body);
  let offset = 0;
  let totalStoredBytes = 0;
  const localOffsets: number[] = [];
  for (const file of files) {
    const localOffset = offset;
    localOffsets.push(localOffset);
    const local = await cursor.take(30);
    const localView = new DataView(local.buffer);
    const nameLength = localView.getUint16(26, true);
    const extraLength = localView.getUint16(28, true);
    if (
      localView.getUint32(0, true) !== 0x04034b50 ||
      localView.getUint16(4, true) !== 20 ||
      localView.getUint16(6, true) !== 0x808 ||
      localView.getUint16(8, true) !== 0 ||
      extraLength !== 0
    )
      throw new Error("ZIP streaming local header is invalid");
    const name = decodeZipName(await cursor.take(nameLength), 0x808);
    if (name !== file.path) throw new Error("ZIP streaming name is invalid");
    offset += 30 + nameLength + extraLength;
    let crc = 0;
    let fileBytes = 0;
    await cursor.consume(MAX_FILE_BYTES, (chunk) => {
      if (!chunk.every((byte) => byte === file.value))
        throw new Error("ZIP streaming body differs from the fixture");
      fileBytes += chunk.byteLength;
      crc = updateCrc32(crc, chunk);
    });
    const descriptor = await cursor.take(16);
    const descriptorView = new DataView(descriptor.buffer);
    if (
      descriptorView.getUint32(0, true) !== 0x08074b50 ||
      descriptorView.getUint32(4, true) !== file.crc32 ||
      descriptorView.getUint32(8, true) !== MAX_FILE_BYTES ||
      descriptorView.getUint32(12, true) !== MAX_FILE_BYTES ||
      crc !== file.crc32 ||
      fileBytes !== MAX_FILE_BYTES
    )
      throw new Error("ZIP streaming descriptor or CRC is invalid");
    offset += MAX_FILE_BYTES + 16;
    totalStoredBytes += fileBytes;
  }

  const centralOffset = offset;
  for (const [index, file] of files.entries()) {
    const central = await cursor.take(46);
    const centralView = new DataView(central.buffer);
    const nameLength = centralView.getUint16(28, true);
    const extraLength = centralView.getUint16(30, true);
    const commentLength = centralView.getUint16(32, true);
    if (
      centralView.getUint32(0, true) !== 0x02014b50 ||
      centralView.getUint16(4, true) !== 0x0314 ||
      centralView.getUint16(6, true) !== 20 ||
      centralView.getUint16(8, true) !== 0x808 ||
      centralView.getUint16(10, true) !== 0 ||
      centralView.getUint32(16, true) !== file.crc32 ||
      centralView.getUint32(20, true) !== MAX_FILE_BYTES ||
      centralView.getUint32(24, true) !== MAX_FILE_BYTES ||
      centralView.getUint32(42, true) !== localOffsets[index] ||
      extraLength !== 0 ||
      commentLength !== 0
    )
      throw new Error("ZIP streaming central header is invalid");
    const name = decodeZipName(await cursor.take(nameLength), 0x808);
    if (name !== file.path)
      throw new Error("ZIP streaming central name is invalid");
    const expectedMode = 0o100000 | 0o644;
    if (centralView.getUint32(38, true) !== (expectedMode << 16) >>> 0)
      throw new Error("ZIP streaming UNIX mode is invalid");
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const eocd = await cursor.take(22);
  const eocdView = new DataView(eocd.buffer);
  if (
    eocdView.getUint32(0, true) !== 0x06054b50 ||
    eocdView.getUint16(8, true) !== files.length ||
    eocdView.getUint16(10, true) !== files.length ||
    eocdView.getUint32(12, true) !== offset - centralOffset ||
    eocdView.getUint32(16, true) !== centralOffset ||
    eocdView.getUint16(20, true) !== 0
  )
    throw new Error("ZIP streaming EOCD is invalid");
  offset += 22;
  await cursor.finish();
  if (offset !== cursor.totalBytes)
    throw new Error("ZIP streaming byte count is invalid");
  return {
    totalBytes: cursor.totalBytes,
    totalStoredBytes,
    maxChunkBytes: cursor.maxChunkBytes,
  };
}

async function consumeToFailure(response: Response): Promise<void> {
  if (!response.body) throw new Error("ZIP response body is missing");
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

class StreamCursor {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private position = 0;
  private done = false;
  totalBytes = 0;
  maxChunkBytes = 0;

  constructor(private readonly stream: ReadableStream<Uint8Array>) {}

  async take(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      await this.fill();
      const available = this.pending.byteLength - this.position;
      const next = Math.min(available, length - offset);
      result.set(
        this.pending.subarray(this.position, this.position + next),
        offset,
      );
      this.position += next;
      offset += next;
    }
    return result;
  }

  async consume(
    length: number,
    callback: (chunk: Uint8Array) => void,
  ): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      await this.fill();
      const available = this.pending.byteLength - this.position;
      const next = Math.min(available, remaining);
      callback(this.pending.subarray(this.position, this.position + next));
      this.position += next;
      remaining -= next;
    }
  }

  async finish(): Promise<void> {
    if (this.pending.byteLength > this.position)
      throw new Error("ZIP has trailing bytes");
    if (this.done) return;
    const reader = this.stream.getReader();
    try {
      const result = await reader.read();
      if (!result.done) throw new Error("ZIP has trailing bytes");
      this.done = true;
    } finally {
      reader.releaseLock();
    }
  }

  private async fill(): Promise<void> {
    if (this.position < this.pending.byteLength) return;
    if (this.done) throw new Error("ZIP ended before the expected record");
    const reader = this.stream.getReader();
    try {
      const result = await reader.read();
      if (result.done) {
        this.done = true;
        throw new Error("ZIP ended before the expected record");
      }
      this.pending = result.value;
      this.position = 0;
      this.totalBytes += result.value.byteLength;
      this.maxChunkBytes = Math.max(
        this.maxChunkBytes,
        result.value.byteLength,
      );
      if (result.value.byteLength > MAX_TEST_STREAM_CHUNK)
        throw new Error("ZIP stream chunk exceeded the test bound");
    } finally {
      reader.releaseLock();
    }
  }
}

function updateCrc32(current: number, bytes: Uint8Array): number {
  let crc = current ^ 0xffffffff;
  for (const byte of bytes)
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

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

async function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(`${ORIGIN}${path}`, init));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function assertArchiveDoesNotContain(
  archive: Uint8Array,
  needles: readonly string[],
): void {
  for (const needle of needles) {
    if (!needle) continue;
    const value = bytes(needle);
    let found = false;
    for (
      let offset = 0;
      offset <= archive.byteLength - value.byteLength;
      offset += 1
    ) {
      let matches = true;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (archive[offset + index] !== value[index]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        found = true;
        break;
      }
    }
    expect(found, `archive unexpectedly contains ${needle}`).toBe(false);
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    value.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function storedPublicationToken(
  artifactId: string,
  publicationId: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT artifact_id, token_ciphertext, token_nonce, encryption_key_version FROM publications WHERE id = ?",
  )
    .bind(publicationId)
    .first<{
      artifact_id: string;
      token_ciphertext: string | null;
      token_nonce: string | null;
      encryption_key_version: number | null;
    }>();
  if (!row || row.artifact_id !== artifactId)
    throw new Error(
      `Publication ciphertext is missing for ${artifactId}/${publicationId}`,
    );
  return decryptPublicationToken(env, {
    id: publicationId,
    artifactId,
    tokenCiphertext: row.token_ciphertext,
    tokenNonce: row.token_nonce,
    encryptionKeyVersion: row.encryption_key_version,
  });
}
