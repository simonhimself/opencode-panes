import {
  artifactIdSchema,
  MAX_MEDIA_TYPE_LENGTH,
  MAX_REMOTE_FILE_BYTES,
  relativePathSchema,
  revisionIdSchema,
  sha256Schema,
} from "@opencode-panes/contracts";

export { MAX_REMOTE_FILE_BYTES };

export interface PrivateRevisionFileInput {
  projectId: string;
  artifactId: string;
  revisionId: string;
  path: string;
  bytes:
    ArrayBuffer | Uint8Array | ReadableStream<ArrayBuffer | ArrayBufferView>;
  mediaType: string;
  byteSize?: number;
  sha256?: string;
}

export interface StoredPrivateRevisionFile {
  path: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
}

export function privateRevisionObjectKey(
  projectId: string,
  artifactId: string,
  revisionId: string,
  path: string,
): string {
  const normalizedProjectId = artifactIdSchema.parse(projectId);
  const normalizedArtifactId = artifactIdSchema.parse(artifactId);
  const normalizedRevisionId = revisionIdSchema.parse(revisionId);
  const normalizedPath = relativePathSchema.parse(path);

  return [
    "private",
    "revisions",
    normalizedProjectId,
    normalizedArtifactId,
    normalizedRevisionId,
    normalizedPath,
  ]
    .map(encodeKeySegment)
    .join("/");
}

export async function putPrivateRevisionFile(
  bucket: R2Bucket,
  input: PrivateRevisionFileInput,
): Promise<StoredPrivateRevisionFile> {
  const mediaType = input.mediaType.trim();
  if (mediaType.length === 0 || mediaType.length > MAX_MEDIA_TYPE_LENGTH) {
    throw new Error("Revision file media type is invalid");
  }

  const objectKey = privateRevisionObjectKey(
    input.projectId,
    input.artifactId,
    input.revisionId,
    input.path,
  );
  const path = relativePathSchema.parse(input.path);
  let byteSize: number;
  let fileHash: string;
  if (input.bytes instanceof ReadableStream) {
    if (input.byteSize === undefined || !input.sha256) {
      throw new Error("Streamed Revision files require size and hash metadata");
    }
    byteSize = input.byteSize;
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0 ||
      byteSize > MAX_REMOTE_FILE_BYTES
    ) {
      throw new Error("Revision file exceeds the remote file limit");
    }
    fileHash = sha256Schema.parse(input.sha256);
    const fixedLength = new FixedLengthStream(byteSize);
    const pipe = input.bytes.pipeTo(fixedLength.writable);
    const put = bucket.put(objectKey, fixedLength.readable, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { sha256: fileHash, byteSize: String(byteSize) },
    });
    await Promise.all([pipe, put]);
  } else {
    const bytes = new Uint8Array(input.bytes);
    byteSize = bytes.byteLength;
    if (!Number.isSafeInteger(byteSize) || byteSize > MAX_REMOTE_FILE_BYTES) {
      throw new Error("Revision file exceeds the remote file limit");
    }
    fileHash = await sha256(bytes);
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { sha256: fileHash, byteSize: String(byteSize) },
    });
  }
  return {
    path,
    objectKey,
    sha256: fileHash,
    byteSize,
    mediaType,
  };
}

export async function getCommittedRevisionFile(
  db: D1Database,
  bucket: R2Bucket,
  input: { revisionId: string; path: string },
): Promise<R2ObjectBody | null> {
  const revisionId = revisionIdSchema.parse(input.revisionId);
  const path = relativePathSchema.parse(input.path);
  const row = await db
    .prepare(
      `SELECT f.object_key
       FROM revision_files f
       JOIN local_revisions r ON r.id = f.revision_id
       WHERE f.revision_id = ?
         AND f.path = ?
         AND r.committed_at IS NOT NULL`,
    )
    .bind(revisionId, path)
    .first<{ object_key: string }>();

  if (!row) return null;
  return bucket.get(row.object_key);
}

function encodeKeySegment(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
