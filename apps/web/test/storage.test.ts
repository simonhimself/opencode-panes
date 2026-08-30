import { createHash } from "node:crypto";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_REMOTE_FILE_BYTES,
  getCommittedRevisionFile,
  putPrivateRevisionFile,
  privateRevisionObjectKey,
} from "../worker/storage";

async function createRevisionFixture(committedAt: string | null) {
  const projectId = `project-${crypto.randomUUID()}`;
  const artifactId = `artifact-${crypto.randomUUID()}`;
  const revisionId = `revision-${crypto.randomUUID()}`;
  const path = "src/file.bin";

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(projectId, "2026-08-29T00:00:00.000Z", "2026-08-29T00:00:00.000Z"),
    env.DB.prepare(
      `INSERT INTO local_artifacts
        (id, project_id, slug, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      artifactId,
      projectId,
      `artifact-${crypto.randomUUID()}`,
      "Storage fixture",
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    ),
    env.DB.prepare(
      `INSERT INTO local_revisions
        (id, artifact_id, version, preview_entry, approved_origins, created_at, committed_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      artifactId,
      JSON.stringify({ adapter: "browser", entryPath: path }),
      "[]",
      "2026-08-29T00:00:00.000Z",
      committedAt,
    ),
  ]);

  return { projectId, artifactId, revisionId, path };
}

async function zeroByteStream(
  byteSize: number,
): Promise<ReadableStream<Uint8Array>> {
  const chunkSize = 64 * 1024;
  let remaining = byteSize;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, remaining);
      controller.enqueue(new Uint8Array(size));
      remaining -= size;
    },
  });
}

async function zeroByteSha256(byteSize: number): Promise<string> {
  const digest = createHash("sha256");
  let remaining = byteSize;
  while (remaining > 0) {
    const size = Math.min(64 * 1024, remaining);
    digest.update(new Uint8Array(size));
    remaining -= size;
  }
  return digest.digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("private Revision file storage", () => {
  it("round-trips exact text, binary, and empty bytes with metadata", async () => {
    const cases = [
      {
        path: "./text.txt",
        bytes: new TextEncoder().encode("line one\r\nline two\n"),
      },
      {
        path: "binary.bin",
        bytes: Uint8Array.from([0, 1, 127, 128, 254, 255]),
      },
      { path: "empty.bin", bytes: new Uint8Array() },
    ];

    for (const { path, bytes } of cases) {
      const fixture = await createRevisionFixture("2026-08-29T00:00:00.000Z");
      const stored = await putPrivateRevisionFile(env.PRIVATE_ARTIFACTS, {
        ...fixture,
        path,
        bytes,
        mediaType: "application/octet-stream",
      });

      await env.DB.prepare(
        `INSERT INTO revision_files
          (revision_id, path, sha256, byte_size, media_type, object_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          fixture.revisionId,
          stored.path,
          stored.sha256,
          stored.byteSize,
          stored.mediaType,
          stored.objectKey,
        )
        .run();

      const object = await getCommittedRevisionFile(
        env.DB,
        env.PRIVATE_ARTIFACTS,
        { revisionId: fixture.revisionId, path },
      );
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
      expect(stored.byteSize).toBe(bytes.byteLength);
      expect(stored.path).toBe(path.replace("./", ""));
      expect(stored.sha256).toBe(sha256Bytes(bytes));

      const metadata = await env.DB.prepare(
        `SELECT path, sha256, byte_size, media_type, object_key
         FROM revision_files
         WHERE revision_id = ? AND path = ?`,
      )
        .bind(fixture.revisionId, stored.path)
        .first<{
          path: string;
          sha256: string;
          byte_size: number;
          media_type: string;
          object_key: string;
        }>();
      expect(metadata).toEqual({
        path: stored.path,
        sha256: sha256Bytes(bytes),
        byte_size: bytes.byteLength,
        media_type: "application/octet-stream",
        object_key: stored.objectKey,
      });
    }
  });

  it("round-trips a maximum-boundary object", async () => {
    const fixture = await createRevisionFixture("2026-08-29T00:00:00.000Z");
    const sha256 = await zeroByteSha256(MAX_REMOTE_FILE_BYTES);
    const stored = await putPrivateRevisionFile(env.PRIVATE_ARTIFACTS, {
      ...fixture,
      path: "maximum.bin",
      bytes: await zeroByteStream(MAX_REMOTE_FILE_BYTES),
      mediaType: "application/octet-stream",
      byteSize: MAX_REMOTE_FILE_BYTES,
      sha256,
    });

    await env.DB.prepare(
      `INSERT INTO revision_files
        (revision_id, path, sha256, byte_size, media_type, object_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        fixture.revisionId,
        "maximum.bin",
        stored.sha256,
        stored.byteSize,
        stored.mediaType,
        stored.objectKey,
      )
      .run();

    const object = await getCommittedRevisionFile(
      env.DB,
      env.PRIVATE_ARTIFACTS,
      { revisionId: fixture.revisionId, path: "maximum.bin" },
    );
    expect(object).not.toBeNull();
    const reader = object!.body.getReader();
    let readBytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value as Uint8Array;
      expect(value.every((byte) => byte === 0)).toBe(true);
      readBytes += value.byteLength;
    }
    expect(readBytes).toBe(MAX_REMOTE_FILE_BYTES);
    expect(stored.byteSize).toBe(MAX_REMOTE_FILE_BYTES);
    expect(stored.sha256).toBe(sha256);
  });

  it("does not read an object until its Revision commit point is present", async () => {
    const fixture = await createRevisionFixture(null);
    const bytes = new TextEncoder().encode("not visible yet");
    const stored = await putPrivateRevisionFile(env.PRIVATE_ARTIFACTS, {
      ...fixture,
      bytes,
      mediaType: "text/plain",
    });

    await env.DB.prepare(
      `INSERT INTO revision_files
        (revision_id, path, sha256, byte_size, media_type, object_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        fixture.revisionId,
        fixture.path,
        stored.sha256,
        stored.byteSize,
        stored.mediaType,
        stored.objectKey,
      )
      .run();

    expect(await env.PRIVATE_ARTIFACTS.get(stored.objectKey)).not.toBeNull();
    expect(
      await getCommittedRevisionFile(env.DB, env.PRIVATE_ARTIFACTS, {
        revisionId: fixture.revisionId,
        path: fixture.path,
      }),
    ).toBeNull();

    await env.DB.prepare(
      "UPDATE local_revisions SET committed_at = ? WHERE id = ?",
    )
      .bind("2026-08-29T00:01:00.000Z", fixture.revisionId)
      .run();

    const committed = await getCommittedRevisionFile(
      env.DB,
      env.PRIVATE_ARTIFACTS,
      { revisionId: fixture.revisionId, path: fixture.path },
    );
    expect(committed).not.toBeNull();
    expect(new Uint8Array(await committed!.arrayBuffer())).toEqual(bytes);
  });

  it("encodes every object-key segment and rejects unsafe paths", () => {
    const key = privateRevisionObjectKey(
      "project/one",
      "artifact/one",
      "revision/one",
      "src/file.bin",
    );

    expect(key).not.toContain("..");
    expect(key).not.toContain("project/one");
    expect(key).not.toContain("src/file.bin");
    expect(key).not.toBe(
      privateRevisionObjectKey(
        "project/one",
        "artifact/one",
        "revision/one",
        "SRC/file.bin",
      ),
    );
    expect(() =>
      privateRevisionObjectKey(
        "project",
        "artifact",
        "revision",
        "../outside.bin",
      ),
    ).toThrow();
  });
});
