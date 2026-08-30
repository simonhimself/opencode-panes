import {
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_REVISION_BYTES,
  relativePathSchema,
  type FinalizedRevision,
} from "@opencode-panes/contracts";

const MAX_CLASSIC_ZIP_VALUE = 0xffffffff;
const MAX_CLASSIC_ZIP_ENTRIES = 0xffff;
const UTF8_FLAG = 0x800;
const DATA_DESCRIPTOR_FLAG = 0x8;
const ZIP_VERSION = 20;
const UNIX_PLATFORM = 3;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;

export interface RevisionArchiveFileRecord {
  path: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  objectKey: string;
}

export interface PreparedRevisionArchive {
  revision: FinalizedRevision;
  files: readonly RevisionArchiveFileRecord[];
  contentLength: number;
}

export function validateArchiveManifestPaths(value: unknown): void {
  if (!value || typeof value !== "object")
    throw new Error("Archive manifest is not an object");
  const revisions = (value as { revisions?: unknown }).revisions;
  if (!Array.isArray(revisions))
    throw new Error("Archive manifest revisions are invalid");
  for (const revision of revisions) {
    if (!revision || typeof revision !== "object")
      throw new Error("Archive manifest revision is invalid");
    const files = (revision as { files?: unknown }).files;
    if (!Array.isArray(files))
      throw new Error("Archive manifest files are invalid");
    for (const file of files) {
      if (!file || typeof file !== "object")
        throw new Error("Archive manifest file is invalid");
      const path = (file as { path?: unknown }).path;
      if (typeof path !== "string" || canonicalArchivePath(path) !== path)
        throw new Error("Archive manifest path is not canonical");
    }
  }
}

interface PreparedArchiveEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  mode: number;
  byteSize: number;
  sha256?: string;
  objectKey?: string;
}

interface ArchiveInput {
  bucket: R2Bucket;
  revision: FinalizedRevision;
  files: readonly RevisionArchiveFileRecord[];
}

export async function prepareRevisionArchive(
  input: ArchiveInput,
): Promise<PreparedRevisionArchive> {
  const entries = validateEntries(input.revision, input.files);
  const fileRecords = new Map(input.files.map((file) => [file.path, file]));
  const metadataChecks = entries.map(async (entry) => {
    if (entry.kind !== "file") return;
    const record = fileRecords.get(entry.path);
    if (!record) throw new Error("Archive file metadata is incomplete");
    const object = await input.bucket.head(record.objectKey);
    if (
      !object ||
      object.size !== record.byteSize ||
      object.customMetadata?.sha256 !== record.sha256 ||
      object.customMetadata?.byteSize !== String(record.byteSize) ||
      object.httpMetadata?.contentType !== record.mediaType
    ) {
      throw new Error("Archive object metadata does not match the Revision");
    }
  });
  await Promise.all(metadataChecks);

  const contentLength = archiveLength(entries);
  return {
    revision: input.revision,
    files: input.files,
    contentLength,
  };
}

export function revisionZipFilename(slug: string, version: number): string {
  const safeSlug =
    slug
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 96)
      .replace(/[-.]+$/gu, "") || "artifact";
  const safeVersion =
    Number.isSafeInteger(version) && version > 0 ? version : 0;
  return `${safeSlug}-v${safeVersion}.zip`;
}

export function revisionArchiveResponse(
  archive: PreparedRevisionArchive,
  bucket: R2Bucket,
  filename: string,
  headOnly = false,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${filename.replace(/[\r\n"]/gu, "_")}"`,
    "Content-Length": String(archive.contentLength),
    "Content-Type": "application/zip",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(headOnly ? null : streamArchive(archive, bucket), {
    status: 200,
    headers,
  });
}

function validateEntries(
  revision: FinalizedRevision,
  files: readonly RevisionArchiveFileRecord[],
): PreparedArchiveEntry[] {
  if (revision.files.length > MAX_CLASSIC_ZIP_ENTRIES)
    throw new Error("Revision has too many archive entries");

  const recordsByPath = new Map(files.map((file) => [file.path, file]));
  if (recordsByPath.size !== files.length) {
    throw new Error("Revision file metadata contains duplicate paths");
  }
  const seen = new Map<string, { path: string; kind: "file" | "directory" }>();
  const entries: PreparedArchiveEntry[] = [];
  let totalBytes = 0;

  for (const file of revision.files) {
    const canonicalPath = canonicalArchivePath(file.path);
    const collisionKey = archiveCollisionKey(canonicalPath);
    const previous = seen.get(collisionKey);
    if (previous) throw new Error("Revision archive paths collide");
    for (const [otherKey, other] of seen) {
      if (
        (collisionKey.startsWith(`${otherKey}/`) && other.kind === "file") ||
        (otherKey.startsWith(`${collisionKey}/`) && file.kind === "file")
      ) {
        throw new Error("Revision archive paths have a file prefix conflict");
      }
    }
    seen.set(collisionKey, { path: canonicalPath, kind: file.kind });

    const name =
      file.kind === "directory" ? `${canonicalPath}/` : canonicalPath;
    const nameBytes = new TextEncoder().encode(name);
    if (nameBytes.byteLength > 0xffff)
      throw new Error("Revision archive path is too long for classic ZIP");
    const mode =
      file.mode ??
      (file.kind === "directory" ? DEFAULT_DIRECTORY_MODE : DEFAULT_FILE_MODE);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
      throw new Error("Revision archive mode is invalid");

    if (file.kind === "directory") {
      entries.push({
        path: canonicalPath,
        name,
        kind: "directory",
        mode,
        byteSize: 0,
      });
      continue;
    }

    const record = recordsByPath.get(file.path);
    if (
      !record ||
      record.path !== file.path ||
      record.sha256 !== file.sha256 ||
      record.byteSize !== file.byteSize ||
      record.mediaType !== file.mediaType
    ) {
      throw new Error("Revision file metadata does not match the manifest");
    }
    if (
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 0 ||
      record.byteSize > MAX_REMOTE_FILE_BYTES ||
      record.byteSize > MAX_CLASSIC_ZIP_VALUE
    ) {
      throw new Error("Revision file size is outside archive limits");
    }
    totalBytes += record.byteSize;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_REMOTE_REVISION_BYTES
    ) {
      throw new Error("Revision size is outside archive limits");
    }
    entries.push({
      path: canonicalPath,
      name,
      kind: "file",
      mode,
      byteSize: record.byteSize,
      sha256: record.sha256,
      objectKey: record.objectKey,
    });
  }
  return entries;
}

function canonicalArchivePath(path: string): string {
  if (relativePathSchema.safeParse(path).success === false)
    throw new Error("Revision archive path is invalid");
  if (
    path.normalize("NFC") !== path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/u.test(path) ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      ) ||
    path
      .split("/")
      .some(
        (segment) =>
          /[ .]$/u.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
      )
  ) {
    throw new Error("Revision archive path is not canonical");
  }
  return path;
}

function archiveCollisionKey(path: string): string {
  return path
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, "").toLocaleLowerCase())
    .join("/");
}

function archiveLength(entries: readonly PreparedArchiveEntry[]): number {
  let offset = 0;
  let centralLength = 0;
  for (const entry of entries) {
    const nameLength = new TextEncoder().encode(entry.name).byteLength;
    checkedZipValue(offset);
    offset = checkedArchiveOffset(offset + 30 + nameLength);
    if (entry.kind === "file") {
      offset = checkedArchiveOffset(offset + entry.byteSize + 16);
    }
    centralLength = checkedArchiveOffset(centralLength + 46 + nameLength);
  }
  checkedZipValue(centralLength);
  checkedZipValue(offset);
  return checkedArchiveOffset(offset + centralLength + 22);
}

async function* archiveChunks(
  archive: PreparedRevisionArchive,
  bucket: R2Bucket,
): AsyncGenerator<Uint8Array> {
  const entries = validateEntries(archive.revision, archive.files);
  const centralRecords: Uint8Array[] = [];
  const timestamp = dosDateTime(archive.revision.createdAt);
  let offset = 0;

  for (const entry of entries) {
    const localOffset = offset;
    const nameBytes = new TextEncoder().encode(entry.name);
    const isFile = entry.kind === "file";
    const local = localHeader(nameBytes, timestamp, isFile);
    yield local;
    offset = checkedArchiveOffset(offset + local.byteLength);

    let crc = 0;
    if (isFile) {
      const object = await bucket.get(entry.objectKey ?? "");
      if (!object || !("body" in object) || !object.body)
        throw new Error("Revision archive object body is unavailable");
      const reader = object.body.getReader();
      const digest = new Sha256();
      let streamedBytes = 0;
      let cancelled = false;
      let complete = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          streamedBytes += value.byteLength;
          if (streamedBytes > entry.byteSize)
            throw new Error("Revision archive object is larger than metadata");
          crc = updateCrc32(crc, value);
          digest.update(value);
          yield value;
        }
        if (streamedBytes !== entry.byteSize)
          throw new Error("Revision archive object is shorter than metadata");
        if (bytesToHex(digest.digest()) !== entry.sha256)
          throw new Error(
            "Revision archive object hash does not match metadata",
          );
        complete = true;
      } catch (error) {
        cancelled = true;
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        if (!complete && !cancelled)
          await reader
            .cancel("Revision archive stream was cancelled")
            .catch(() => undefined);
        reader.releaseLock();
      }
      const descriptor = dataDescriptor(crc, streamedBytes);
      yield descriptor;
      offset = checkedArchiveOffset(
        offset + entry.byteSize + descriptor.byteLength,
      );
    }
    centralRecords.push(
      centralHeader(nameBytes, timestamp, entry, crc, localOffset),
    );
  }

  const centralOffset = offset;
  for (const record of centralRecords) {
    yield record;
    offset = checkedArchiveOffset(offset + record.byteLength);
  }
  const centralSize = offset - centralOffset;
  yield endOfCentralDirectory(
    centralRecords.length,
    centralSize,
    centralOffset,
  );
}

function streamArchive(
  archive: PreparedRevisionArchive,
  bucket: R2Bucket,
): ReadableStream<Uint8Array> {
  const iterator = archiveChunks(archive, bucket);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return(reason);
    },
  });
}

function localHeader(
  name: Uint8Array,
  timestamp: { time: number; date: number },
  isFile: boolean,
): Uint8Array {
  const record = new Uint8Array(30 + name.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(
    6,
    isFile ? UTF8_FLAG | DATA_DESCRIPTOR_FLAG : UTF8_FLAG,
    true,
  );
  view.setUint16(8, 0, true);
  view.setUint16(10, timestamp.time, true);
  view.setUint16(12, timestamp.date, true);
  view.setUint16(26, name.byteLength, true);
  record.set(name, 30);
  return record;
}

function centralHeader(
  name: Uint8Array,
  timestamp: { time: number; date: number },
  entry: PreparedArchiveEntry,
  crc: number,
  localOffset: number,
): Uint8Array {
  const record = new Uint8Array(46 + name.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, (UNIX_PLATFORM << 8) | ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(
    8,
    entry.kind === "file" ? UTF8_FLAG | DATA_DESCRIPTOR_FLAG : UTF8_FLAG,
    true,
  );
  view.setUint16(10, 0, true);
  view.setUint16(12, timestamp.time, true);
  view.setUint16(14, timestamp.date, true);
  view.setUint32(16, crc >>> 0, true);
  view.setUint32(20, entry.byteSize, true);
  view.setUint32(24, entry.byteSize, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint32(
    38,
    (((entry.kind === "directory" ? 0o040000 : 0o100000) | entry.mode) << 16) |
      (entry.kind === "directory" ? 0x10 : 0),
    true,
  );
  view.setUint32(42, localOffset, true);
  record.set(name, 46);
  return record;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const record = new Uint8Array(16);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc >>> 0, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return record;
}

function endOfCentralDirectory(
  entries: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return record;
}

function dosDateTime(value: string): { time: number; date: number } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("Revision timestamp is invalid");
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

function updateCrc32(current: number, bytes: Uint8Array): number {
  let crc = current ^ 0xffffffff;
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

function checkedZipValue(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_CLASSIC_ZIP_VALUE
  )
    throw new Error("Revision archive exceeds classic ZIP limits");
  return value;
}

function checkedArchiveOffset(value: number): number {
  return checkedZipValue(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private buffered = 0;
  private totalBytes = 0;

  update(bytes: Uint8Array): void {
    this.totalBytes += bytes.byteLength;
    let offset = 0;
    if (this.buffered > 0) {
      const copied = Math.min(64 - this.buffered, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, copied), this.buffered);
      this.buffered += copied;
      offset += copied;
      if (this.buffered === 64) {
        this.compress(this.buffer);
        this.buffered = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.compress(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.buffered = bytes.byteLength - offset;
    }
  }

  digest(): Uint8Array {
    const bitLength = this.totalBytes * 8;
    this.buffer[this.buffered] = 0x80;
    this.buffered += 1;
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered);
      this.compress(this.buffer);
      this.buffered = 0;
    }
    this.buffer.fill(0, this.buffered, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.compress(this.buffer);

    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < this.state.length; index += 1)
      outputView.setUint32(index * 4, this.state[index]!, false);
    return output;
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15]!;
      const value2 = words[index - 2]!;
      words[index] =
        (smallSigma1(value2) +
          words[index - 7]! +
          smallSigma0(value) +
          words[index - 16]!) >>>
        0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const temp1 =
        (h +
          bigSigma1(e) +
          choose(e, f, g) +
          SHA256_CONSTANTS[index]! +
          words[index]!) >>>
        0;
      const temp2 = (bigSigma0(a) + majority(a, b, c)) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function smallSigma0(value: number): number {
  return (rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)) >>> 0;
}

function smallSigma1(value: number): number {
  return (
    (rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)) >>> 0
  );
}

function bigSigma0(value: number): number {
  return (
    (rotateRight(value, 2) ^
      rotateRight(value, 13) ^
      rotateRight(value, 22)) >>>
    0
  );
}

function bigSigma1(value: number): number {
  return (
    (rotateRight(value, 6) ^
      rotateRight(value, 11) ^
      rotateRight(value, 25)) >>>
    0
  );
}

function choose(value: number, left: number, right: number): number {
  return ((value & left) ^ (~value & right)) >>> 0;
}

function majority(value: number, left: number, right: number): number {
  return ((value & left) ^ (value & right) ^ (left & right)) >>> 0;
}

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
