import {
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_REVISION_BYTES,
  artifactIdSchema,
  ownerTokenSchema,
  relativePathSchema,
  syncCreateRequestSchema,
  syncCreateResponseSchema,
  cloudManifestSchema,
  syncRevisionCommitRequestSchema,
  syncRevisionCommitResponseSchema,
  type ApiErrorCode,
  type CloudManifest,
  type ErrorIssue,
} from "@opencode-panes/contracts";

import {
  getCommittedRevisionFile,
  putPrivateRevisionFile,
  privateRevisionObjectKey,
} from "./storage";

const SYNC_CREATE_KEY_HEADER = "X-Panes-Create-Key";
const FILE_HASH_HEADER = "X-Panes-File-SHA256";
const FILE_SIZE_HEADER = "X-Panes-File-Byte-Size";
const SYNC_BODY_LIMIT = 16 * 1024 * 1024;
const CREATOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

interface SyncArtifactRow {
  cloud_artifact_id: string;
  cloud_project_id: string;
  local_project_id: string;
  local_artifact_id: string;
  slug: string;
  title: string;
  kind: string | null;
  owner_token_hash: string;
  creation_idempotency_key: string;
  creator_token_hash: string;
  creator_created_at: string;
  creator_expires_at: string;
}

interface CommittedRevisionRow {
  id: string;
  artifact_id: string;
  version: number;
  committed_at: string | null;
  cloud_manifest_key: string | null;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: Response };

export async function routeSyncRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/sync/artifacts") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return createSyncArtifact(request, env);
  }

  const fileMatch = pathname.match(
    /^\/api\/sync\/artifacts\/([^/]+)\/revisions\/(\d+)\/files\/(.+)$/u,
  );
  if (fileMatch) {
    const artifactId = parseArtifactId(fileMatch[1]);
    const version = parseVersion(fileMatch[2]);
    const path = decodePathSegment(fileMatch[3]);
    if (artifactId instanceof Response) return artifactId;
    if (version instanceof Response) return version;
    if (!path)
      return errorResponse(400, "VALIDATION_ERROR", "File path is invalid");
    if (request.method === "PUT") {
      return uploadSyncFile(request, env, artifactId, version, path);
    }
    if (request.method === "GET") {
      return readSyncFile(request, env, artifactId, version, path);
    }
    return methodNotAllowed(["GET", "PUT"]);
  }

  const commitMatch = pathname.match(
    /^\/api\/sync\/artifacts\/([^/]+)\/revisions\/(\d+)\/commit$/u,
  );
  if (commitMatch) {
    const artifactId = parseArtifactId(commitMatch[1]);
    const version = parseVersion(commitMatch[2]);
    if (artifactId instanceof Response) return artifactId;
    if (version instanceof Response) return version;
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return commitSyncRevision(request, env, artifactId, version);
  }

  return undefined;
}

async function createSyncArtifact(
  request: Request,
  env: Env,
): Promise<Response> {
  const admissionError = await requireCreateAdmission(
    request,
    env.PANES_CREATE_API_KEY,
  );
  if (admissionError) return admissionError;
  const body = await parseJsonBody(
    request,
    syncCreateRequestSchema,
    SYNC_BODY_LIMIT,
  );
  if (!body.ok) return body.response;

  const existing = await env.DB.prepare(
    `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
            local_artifact_id, slug, title, kind, owner_token_hash,
            creation_idempotency_key, creator_token_hash,
            creator_created_at, creator_expires_at
       FROM sync_artifacts
      WHERE creation_idempotency_key = ?`,
  )
    .bind(body.data.idempotencyKey)
    .first<SyncArtifactRow>();
  if (existing) {
    if (!(await sameCreationRequest(existing, body.data))) {
      return errorResponse(
        409,
        "CONFLICT",
        "The Sync creation idempotency key already belongs to different content",
      );
    }
    return syncCreateResponse(
      request,
      existing,
      body.data.ownerCredential,
      body.data.creatorToken,
    );
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CREATOR_TTL_MS).toISOString();
  const cloudArtifactId = `cloud_artifact_${crypto.randomUUID()}`;
  const cloudProjectId = body.data.projectId;
  const ownerTokenHash = await hashToken(body.data.ownerCredential);
  const creatorTokenHash = await hashToken(body.data.creatorToken);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO projects (id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(body.data.projectId, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO local_artifacts
          (id, project_id, slug, title, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        cloudArtifactId,
        cloudProjectId,
        body.data.slug,
        body.data.title,
        body.data.kind ?? null,
        createdAt,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO sync_artifacts
          (cloud_artifact_id, cloud_project_id, local_project_id,
           local_artifact_id, slug, title, kind, owner_token_hash,
           creation_idempotency_key, creator_token_hash, creator_created_at,
           creator_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        cloudArtifactId,
        cloudProjectId,
        body.data.projectId,
        body.data.artifactId,
        body.data.slug,
        body.data.title,
        body.data.kind ?? null,
        ownerTokenHash,
        body.data.idempotencyKey,
        creatorTokenHash,
        createdAt,
        expiresAt,
        createdAt,
        createdAt,
      ),
    ]);
  } catch (error) {
    const replay = await env.DB.prepare(
      `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
              local_artifact_id, slug, title, kind, owner_token_hash,
              creation_idempotency_key, creator_token_hash,
              creator_created_at, creator_expires_at
         FROM sync_artifacts
        WHERE creation_idempotency_key = ?`,
    )
      .bind(body.data.idempotencyKey)
      .first<SyncArtifactRow>();
    if (replay && (await sameCreationRequest(replay, body.data))) {
      return syncCreateResponse(
        request,
        replay,
        body.data.ownerCredential,
        body.data.creatorToken,
      );
    }
    throw error;
  }

  const result: SyncArtifactRow = {
    cloud_artifact_id: cloudArtifactId,
    cloud_project_id: cloudProjectId,
    local_project_id: body.data.projectId,
    local_artifact_id: body.data.artifactId,
    slug: body.data.slug,
    title: body.data.title,
    kind: body.data.kind ?? null,
    owner_token_hash: ownerTokenHash,
    creation_idempotency_key: body.data.idempotencyKey,
    creator_token_hash: creatorTokenHash,
    creator_created_at: createdAt,
    creator_expires_at: expiresAt,
  };
  return syncCreateResponse(
    request,
    result,
    body.data.ownerCredential,
    body.data.creatorToken,
    201,
  );
}

async function sameCreationRequest(
  row: SyncArtifactRow,
  request: {
    projectId: string;
    artifactId: string;
    slug: string;
    title: string;
    kind?: string | undefined;
    ownerCredential: string;
    creatorToken: string;
  },
) {
  const [ownerHash, creatorHash] = await Promise.all([
    hashToken(request.ownerCredential),
    hashToken(request.creatorToken),
  ]);
  return (
    row.cloud_project_id === request.projectId &&
    row.local_artifact_id === request.artifactId &&
    row.slug === request.slug &&
    row.title === request.title &&
    (row.kind ?? undefined) === request.kind &&
    constantTimeHashEqual(row.owner_token_hash, ownerHash) &&
    constantTimeHashEqual(row.creator_token_hash, creatorHash)
  );
}

function syncCreateResponse(
  request: Request,
  row: SyncArtifactRow,
  ownerCredential: string,
  creatorToken: string,
  status = 200,
): Response {
  const response = syncCreateResponseSchema.parse({
    cloudProjectId: row.cloud_project_id,
    cloudArtifactId: row.cloud_artifact_id,
    ownerCredential,
    creatorUrl: new URL(
      `/creator/${encodeURIComponent(creatorToken)}`,
      request.url,
    ).toString(),
    inventoryUrl: new URL("/inventory", request.url).toString(),
    creatorExpiresAt: row.creator_expires_at,
  });
  return jsonResponse(response, status);
}

async function uploadSyncFile(
  request: Request,
  env: Env,
  artifactId: string,
  version: number,
  pathInput: string,
): Promise<Response> {
  const artifact = await authenticateSyncOwner(request, env.DB, artifactId);
  if (artifact instanceof Response) return artifact;
  const path = relativePathSchema.safeParse(pathInput);
  if (!path.success)
    return errorResponse(400, "VALIDATION_ERROR", "File path is invalid");
  if (mandatoryExclusion(path.data)) {
    return errorResponse(
      422,
      "VALIDATION_ERROR",
      "Revision file path is a mandatory exclusion",
    );
  }

  const bytes = await readBoundedBody(request, MAX_REMOTE_FILE_BYTES);
  if (!bytes)
    return errorResponse(413, "FILE_TOO_LARGE", "Revision file is too large");
  const declaredSize = Number(request.headers.get(FILE_SIZE_HEADER));
  const declaredHash = request.headers.get(FILE_HASH_HEADER) ?? "";
  const actualHash = await hashBytes(bytes);
  if (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize !== bytes.byteLength ||
    !/^[a-f0-9]{64}$/u.test(declaredHash) ||
    !constantTimeHashEqual(actualHash, declaredHash)
  ) {
    return errorResponse(
      422,
      "HASH_MISMATCH",
      "Revision file metadata does not match its bytes",
    );
  }

  await putPrivateRevisionFile(env.PRIVATE_ARTIFACTS, {
    projectId: artifact.cloud_project_id,
    artifactId,
    revisionId: syncRevisionId(artifactId, version),
    path: path.data,
    bytes,
    mediaType:
      request.headers.get("Content-Type") ?? "application/octet-stream",
    byteSize: declaredSize,
    sha256: declaredHash,
  });
  return new Response(null, { status: 204 });
}

async function commitSyncRevision(
  request: Request,
  env: Env,
  artifactId: string,
  version: number,
): Promise<Response> {
  const artifact = await authenticateSyncOwner(request, env.DB, artifactId);
  if (artifact instanceof Response) return artifact;
  const body = await parseJsonBody(
    request,
    syncRevisionCommitRequestSchema,
    SYNC_BODY_LIMIT,
  );
  if (!body.ok) return body.response;
  const manifest = body.data.manifest;
  const revision = manifest.revisions.at(-1);
  if (
    manifest.revisions.length !== version ||
    !revision ||
    manifest.projectId !== artifact.cloud_project_id ||
    manifest.artifactId !== artifactId ||
    manifest.slug !== artifact.slug ||
    manifest.title !== artifact.title ||
    (manifest.kind ?? undefined) !== (artifact.kind ?? undefined) ||
    revision.version !== version
  ) {
    return errorResponse(
      409,
      "CONFLICT",
      "Cloud manifest does not match the Sync Artifact",
    );
  }
  if (
    manifest.revisions.some(
      (candidate, index) => candidate.version !== index + 1,
    )
  ) {
    return errorResponse(
      409,
      "CONFLICT",
      "Cloud manifest revisions must be a contiguous committed history",
    );
  }
  const fileEntries = revision.files.filter((file) => file.kind === "file");
  const totalBytes = fileEntries.reduce(
    (total, file) => total + file.byteSize,
    0,
  );
  if (fileEntries.some((file) => file.byteSize > MAX_REMOTE_FILE_BYTES)) {
    return errorResponse(413, "FILE_TOO_LARGE", "Revision file is too large");
  }
  if (totalBytes > MAX_REMOTE_REVISION_BYTES) {
    return errorResponse(413, "REVISION_TOO_LARGE", "Revision is too large");
  }
  if (
    manifest.revisions.some((candidate) =>
      candidate.files.some((file) => mandatoryExclusion(file.path)),
    )
  ) {
    return errorResponse(
      422,
      "VALIDATION_ERROR",
      "Cloud manifest contains a mandatory exclusion",
    );
  }
  if (
    mandatoryExclusion(revision.preview.entryPath) ||
    !fileEntries.some((file) => file.path === revision.preview.entryPath)
  ) {
    return errorResponse(
      422,
      "VALIDATION_ERROR",
      "Cloud manifest Preview entry must be an uploaded file",
    );
  }

  const revisionId = syncRevisionId(artifactId, version);
  const existing = await env.DB.prepare(
    `SELECT id, artifact_id, version, committed_at, cloud_manifest_key
       FROM local_revisions
      WHERE artifact_id = ? AND version = ?`,
  )
    .bind(artifactId, version)
    .first<CommittedRevisionRow>();
  if (existing?.committed_at) {
    if (
      !existing.cloud_manifest_key ||
      !(await committedManifestMatches(
        env.PRIVATE_ARTIFACTS,
        existing.cloud_manifest_key,
        manifest,
      ))
    ) {
      return errorResponse(
        409,
        "CONFLICT",
        "Revision number is already assigned to different content",
      );
    }
    return jsonResponse(
      syncRevisionCommitResponseSchema.parse({
        cloudArtifactId: artifactId,
        version,
        committedAt: existing.committed_at,
      }),
    );
  }
  const committedHistory = await env.DB.prepare(
    `SELECT id, artifact_id, version, committed_at, cloud_manifest_key
       FROM local_revisions
      WHERE artifact_id = ? AND committed_at IS NOT NULL
      ORDER BY version ASC`,
  )
    .bind(artifactId)
    .all<CommittedRevisionRow>();
  if (committedHistory.results.length !== version - 1) {
    return errorResponse(
      409,
      "CONFLICT",
      "Revisions must be committed in local version order",
    );
  }
  for (const committed of committedHistory.results) {
    if (committed.version < 1 || committed.version >= version) {
      return errorResponse(
        409,
        "CONFLICT",
        "Existing committed Revision history is not contiguous",
      );
    }
    if (!committed.cloud_manifest_key) {
      return errorResponse(
        409,
        "CONFLICT",
        "Existing committed Revision is missing its cloud manifest",
      );
    }
    const prefix: CloudManifest = {
      ...manifest,
      revisions: manifest.revisions.slice(0, committed.version),
    };
    if (
      !(await committedManifestMatches(
        env.PRIVATE_ARTIFACTS,
        committed.cloud_manifest_key,
        prefix,
      ))
    ) {
      return errorResponse(
        409,
        "CONFLICT",
        "Cloud manifest does not describe the committed Revision history",
      );
    }
  }
  if (existing && existing.id !== revisionId) {
    return errorResponse(
      409,
      "CONFLICT",
      "Revision number is already assigned to different content",
    );
  }

  const objectFiles = await verifyUploadedFiles(
    env.PRIVATE_ARTIFACTS,
    artifact.cloud_project_id,
    artifactId,
    version,
    fileEntries,
  );
  const committedAt = new Date().toISOString();
  const manifestKey = syncManifestKey(
    artifact.cloud_project_id,
    artifactId,
    version,
  );
  await env.PRIVATE_ARTIFACTS.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });

  const fileStatements = objectFiles.map((file) =>
    env.DB.prepare(
      `INSERT INTO revision_files
        (revision_id, path, sha256, byte_size, media_type, object_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      file.path,
      file.sha256,
      file.byteSize,
      file.mediaType,
      file.objectKey,
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO local_revisions
        (id, artifact_id, version, preview_entry, approved_origins,
         created_at, committed_at, cloud_manifest_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      artifactId,
      version,
      JSON.stringify(revision.preview),
      JSON.stringify(revision.approvedOrigins),
      revision.createdAt,
      committedAt,
      manifestKey,
    ),
    ...fileStatements,
  ]);
  return jsonResponse(
    syncRevisionCommitResponseSchema.parse({
      cloudArtifactId: artifactId,
      version,
      committedAt,
    }),
    201,
  );
}

async function committedManifestMatches(
  bucket: R2Bucket,
  manifestKey: string,
  manifest: CloudManifest,
) {
  const object = await bucket.get(manifestKey);
  if (!object) return false;
  try {
    const stored = cloudManifestSchema.parse(await object.json());
    return canonicalJson(stored) === canonicalJson(manifest);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function verifyUploadedFiles(
  bucket: R2Bucket,
  projectId: string,
  artifactId: string,
  version: number,
  files: Array<
    Extract<
      CloudManifest["revisions"][number]["files"][number],
      { kind: "file" }
    >
  >,
) {
  const result = [];
  for (const file of files) {
    const objectKey = privateRevisionObjectKey(
      projectId,
      artifactId,
      syncRevisionId(artifactId, version),
      file.path,
    );
    const object = await bucket.head(objectKey);
    if (
      !object ||
      object.size !== file.byteSize ||
      object.customMetadata?.sha256 !== file.sha256 ||
      object.customMetadata?.byteSize !== String(file.byteSize)
    ) {
      throw new Error(
        `Uploaded bytes for ${file.path} do not match the cloud manifest`,
      );
    }
    result.push({ ...file, objectKey });
  }
  return result;
}

async function readSyncFile(
  request: Request,
  env: Env,
  artifactId: string,
  version: number,
  pathInput: string,
): Promise<Response> {
  const artifact = await authenticateSyncOwner(request, env.DB, artifactId);
  if (artifact instanceof Response) return artifact;
  const path = relativePathSchema.safeParse(pathInput);
  if (!path.success)
    return errorResponse(400, "VALIDATION_ERROR", "File path is invalid");
  const object = await getCommittedRevisionFile(env.DB, env.PRIVATE_ARTIFACTS, {
    revisionId: syncRevisionId(artifactId, version),
    path: path.data,
  });
  if (!object)
    return errorResponse(404, "NOT_FOUND", "Revision file not found");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "no-store");
  return new Response(object.body, { headers });
}

async function authenticateSyncOwner(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<SyncArtifactRow | Response> {
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token || !ownerTokenSchema.safeParse(token).success) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "A bearer owner credential is required",
    );
  }
  const row = await db
    .prepare(
      `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
              local_artifact_id, slug, title, kind, owner_token_hash,
              creation_idempotency_key, creator_token_hash,
              creator_created_at, creator_expires_at
         FROM sync_artifacts
        WHERE cloud_artifact_id = ?`,
    )
    .bind(artifactId)
    .first<SyncArtifactRow>();
  if (!row) return errorResponse(404, "NOT_FOUND", "Sync Artifact not found");
  if (!constantTimeHashEqual(row.owner_token_hash, await hashToken(token))) {
    return errorResponse(403, "FORBIDDEN", "The owner credential is invalid");
  }
  return row;
}

async function requireCreateAdmission(
  request: Request,
  expectedKey: string | undefined,
): Promise<Response | undefined> {
  if (expectedKey === undefined) return undefined;
  const provided = request.headers.get(SYNC_CREATE_KEY_HEADER) ?? "";
  if (await timingSafeSecretEqual(provided, expectedKey)) return undefined;
  return errorResponse(
    401,
    "UNAUTHORIZED",
    "Sync creation requires a valid admission key",
  );
}

async function parseJsonBody<T>(
  request: Request,
  parser: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: {
            issues: ReadonlyArray<{
              path: readonly PropertyKey[];
              message: string;
            }>;
          };
        };
  },
  maxBytes: number,
): Promise<ParsedBody<T>> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return validationResponse([
      { path: [], message: "Content-Type must be application/json" },
    ]);
  }
  const bytes = await readBoundedBody(request, maxBytes);
  if (!bytes) {
    return {
      ok: false,
      response: errorResponse(
        413,
        "SOURCE_TOO_LARGE",
        "Sync request is too large",
      ),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return validationResponse([
      { path: [], message: "Body must be valid UTF-8 JSON" },
    ]);
  }
  const result = parser.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return validationResponse(result.error.issues.map(toErrorIssue));
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Request body exceeds the limit");
      return undefined;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function mandatoryExclusion(path: string) {
  const segments = path.split("/");
  return segments.some((segment) => {
    const lower = segment.toLocaleLowerCase();
    return (
      lower === ".panesignore" ||
      lower === "artifact.json" ||
      lower === "draft" ||
      lower === "draft.json" ||
      lower === ".git" ||
      lower === "node_modules" ||
      lower === "vendor" ||
      lower === ".cache" ||
      lower === ".parcel-cache" ||
      lower === ".vite" ||
      lower === ".turbo" ||
      lower === "__pycache__" ||
      lower === ".next" ||
      lower === ".nuxt" ||
      lower === "coverage" ||
      lower === ".env" ||
      lower.startsWith(".env.") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key") ||
      lower.endsWith(".p12")
    );
  });
}

function syncRevisionId(artifactId: string, version: number) {
  return `sync_revision_${artifactId}_${version}`;
}

function syncManifestKey(
  projectId: string,
  artifactId: string,
  version: number,
) {
  return `private/manifests/${encodeKey(projectId)}/${encodeKey(artifactId)}/v${version}.json`;
}

function encodeKey(value: string) {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseArtifactId(value: string | undefined): string | Response {
  const parsed = artifactIdSchema.safeParse(decodePathSegment(value));
  return parsed.success
    ? parsed.data
    : errorResponse(400, "VALIDATION_ERROR", "Artifact ID is invalid");
}

function parseVersion(value: string | undefined): number | Response {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0
    ? version
    : errorResponse(400, "VALIDATION_ERROR", "Revision version is invalid");
}

function decodePathSegment(value: string | undefined) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

async function hashToken(value: string) {
  return hashBytes(new TextEncoder().encode(value));
}

async function hashBytes(value: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    value.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeHashEqual(left: string, right: string) {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (!leftBytes || !rightBytes) return false;
  return (crypto.subtle as TimingSafeSubtleCrypto).timingSafeEqual(
    leftBytes,
    rightBytes,
  );
}

async function timingSafeSecretEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    hashToken(left),
    hashToken(right),
  ]);
  return constantTimeHashEqual(leftHash, rightHash);
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]{64}$/u.test(value)) return undefined;
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function toErrorIssue(issue: {
  path: readonly PropertyKey[];
  message: string;
}): ErrorIssue {
  return {
    path: issue.path.map((part) =>
      typeof part === "number" ? part : String(part),
    ),
    message: issue.message,
  };
}

function validationResponse(issues: ErrorIssue[]): ParsedBody<never> {
  return {
    ok: false,
    response: errorResponse(
      400,
      "VALIDATION_ERROR",
      "Request validation failed",
      issues,
    ),
  };
}

function methodNotAllowed(methods: string[]) {
  return errorResponse(
    405,
    "VALIDATION_ERROR",
    "Method not allowed",
    undefined,
    {
      Allow: methods.join(", "),
    },
  );
}

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  issues?: ErrorIssue[],
  extraHeaders?: HeadersInit,
) {
  return jsonResponse(
    { error: issues ? { code, message, issues } : { code, message } },
    status,
    extraHeaders,
  );
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
) {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, name) =>
      headers.set(name, value),
    );
  }
  return new Response(JSON.stringify(value), { status, headers });
}
