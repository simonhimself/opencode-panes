import {
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_REVISION_BYTES,
  artifactIdSchema,
  approvedOriginsSchema,
  creatorWorkspaceResponseSchema,
  ownerTokenSchema,
  previewEntrySchema,
  relativePathSchema,
  syncCreateRequestSchema,
  syncCreateResponseSchema,
  cloudManifestSchema,
  syncRevisionCommitRequestSchema,
  syncRevisionCommitResponseSchema,
  syncCreatorRotateRequestSchema,
  syncCreatorRotateResponseSchema,
  type ApiErrorCode,
  type CloudManifest,
  type ErrorIssue,
} from "@opencode-panes/contracts";
import {
  createPreviewCsp,
  normalizePreviewContentType,
} from "@opencode-panes/renderers/preview-security";

import { getCommittedRevisionFile, privateRevisionObjectKey } from "./storage";
import { getPublicationSnapshot, routePublicationRequest } from "./publication";
import {
  prepareRevisionArchive,
  revisionArchiveResponse,
  revisionZipFilename,
  validateArchiveManifestPaths,
} from "./zip";

const SYNC_CREATE_KEY_HEADER = "X-Panes-Create-Key";
const FILE_HASH_HEADER = "X-Panes-File-SHA256";
const FILE_SIZE_HEADER = "X-Panes-File-Byte-Size";
const SYNC_SESSION_HEADER = "X-Panes-Sync-Session";
const SYNC_BODY_LIMIT = 16 * 1024 * 1024;
const CREATOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SYNC_LEASE_TTL_MS = 60 * 1000;
export const TEMP_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const CREATOR_CAPABILITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
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
  sync_lease_owner?: string | null;
  sync_lease_expires_at?: string | null;
  lifecycle_state?: "active" | "deleting";
}

export interface InventoryCreatorRotation {
  creatorUrl: string;
  creatorExpiresAt: string;
}

interface SyncUploadRow {
  cloud_project_id: string;
  artifact_id: string;
  revision_version: number;
  session_id: string;
  path: string;
  expected_sha256: string;
  expected_byte_size: number;
  expected_media_type: string;
  object_key: string;
  created_at: string;
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
  const publicationResponse = await routePublicationRequest(request, env);
  if (publicationResponse) return publicationResponse;
  if (pathname === "/api/sync/artifacts") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return createSyncArtifact(request, env);
  }

  const creatorDownloadMatch = pathname.match(
    /^\/api\/creator\/([^/]+)\/revisions\/(\d+)\/download\.zip$/u,
  );
  if (creatorDownloadMatch) {
    const token = decodePathSegment(creatorDownloadMatch[1]);
    const version = parseVersion(creatorDownloadMatch[2]);
    if (!token || !ownerTokenSchema.safeParse(token).success)
      return errorResponse(
        404,
        "NOT_FOUND",
        "Creator link not found",
        undefined,
        CREATOR_CAPABILITY_HEADERS,
      );
    if (version instanceof Response) return version;
    if (request.method !== "GET" && request.method !== "HEAD")
      return methodNotAllowed(["GET", "HEAD"], CREATOR_CAPABILITY_HEADERS);
    return downloadCreatorRevision(request, env, token, version);
  }

  const creatorMatch = pathname.match(/^\/api\/creator\/([^/]+)$/u);
  if (creatorMatch) {
    const token = decodePathSegment(creatorMatch[1]);
    if (!token || !ownerTokenSchema.safeParse(token).success)
      return errorResponse(
        404,
        "NOT_FOUND",
        "Creator link not found",
        undefined,
        CREATOR_CAPABILITY_HEADERS,
      );
    return readCreatorCapability(request, env, token);
  }

  const creatorFileMatch = pathname.match(
    /^\/api\/creator\/([^/]+)\/revisions\/(\d+)\/files\/(.+)$/u,
  );
  if (creatorFileMatch) {
    const token = decodePathSegment(creatorFileMatch[1]);
    const version = parseVersion(creatorFileMatch[2]);
    const path = decodePathSegment(creatorFileMatch[3]);
    if (!token || !ownerTokenSchema.safeParse(token).success)
      return errorResponse(
        404,
        "NOT_FOUND",
        "Creator link not found",
        undefined,
        CREATOR_CAPABILITY_HEADERS,
      );
    if (version instanceof Response) return version;
    if (!path || !relativePathSchema.safeParse(path).success)
      return errorResponse(
        404,
        "NOT_FOUND",
        "Revision file not found",
        undefined,
        CREATOR_CAPABILITY_HEADERS,
      );
    if (request.method !== "GET" && request.method !== "HEAD")
      return methodNotAllowed(["GET", "HEAD"], CREATOR_CAPABILITY_HEADERS);
    return readCreatorFile(request, env, token, version, path);
  }

  if (pathname.startsWith("/api/creator/"))
    return errorResponse(
      404,
      "NOT_FOUND",
      "Creator route not found",
      undefined,
      CREATOR_CAPABILITY_HEADERS,
    );

  const rotateMatch = pathname.match(
    /^\/api\/sync\/artifacts\/([^/]+)\/creator\/rotate$/u,
  );
  if (rotateMatch) {
    const artifactId = parseArtifactId(rotateMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return rotateCreatorLink(request, env, artifactId);
  }

  const releaseMatch = pathname.match(
    /^\/api\/sync\/artifacts\/([^/]+)\/lease\/release$/u,
  );
  if (releaseMatch) {
    const artifactId = parseArtifactId(releaseMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return releaseSyncLease(request, env.DB, artifactId);
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
    if (request.method === "PUT" || request.method === "HEAD") {
      return uploadSyncFile(request, env, artifactId, version, path);
    }
    if (request.method === "GET") {
      return readSyncFile(request, env, artifactId, version, path);
    }
    return methodNotAllowed(["GET", "HEAD", "PUT"]);
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
             creator_created_at, creator_expires_at, lifecycle_state
       FROM sync_artifacts
      WHERE creation_idempotency_key = ?`,
  )
    .bind(body.data.idempotencyKey)
    .first<SyncArtifactRow>();
  if (existing) {
    if (existing.lifecycle_state === "deleting")
      return errorResponse(409, "CONFLICT", "Sync Artifact is being deleted");
    if (!(await sameCreationRequest(existing, body.data))) {
      return errorResponse(
        409,
        "CONFLICT",
        "The Sync creation idempotency key already belongs to different content",
      );
    }
    const leaseError = await acquireSyncLease(
      request,
      env.DB,
      existing.cloud_artifact_id,
    );
    if (leaseError) return leaseError;
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
            creator_expires_at, created_at, updated_at,
            sync_lease_owner, sync_lease_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        sessionId(request),
        new Date(Date.now() + SYNC_LEASE_TTL_MS).toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO creator_links
          (id, artifact_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        `creator_link_${cloudArtifactId}`,
        cloudArtifactId,
        creatorTokenHash,
        createdAt,
        expiresAt,
      ),
    ]);
  } catch (error) {
    const replay = await env.DB.prepare(
      `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
              local_artifact_id, slug, title, kind, owner_token_hash,
               creation_idempotency_key, creator_token_hash,
               creator_created_at, creator_expires_at, lifecycle_state
         FROM sync_artifacts
        WHERE creation_idempotency_key = ?`,
    )
      .bind(body.data.idempotencyKey)
      .first<SyncArtifactRow>();
    if (replay && (await sameCreationRequest(replay, body.data))) {
      if (replay.lifecycle_state === "deleting")
        return errorResponse(409, "CONFLICT", "Sync Artifact is being deleted");
      const leaseError = await acquireSyncLease(
        request,
        env.DB,
        replay.cloud_artifact_id,
      );
      if (leaseError) return leaseError;
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
  return jsonResponse(response, status, CREATOR_CAPABILITY_HEADERS);
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
  const leaseError = await acquireSyncLease(request, env.DB, artifactId);
  if (leaseError) return leaseError;
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

  const declaredSize = Number(request.headers.get(FILE_SIZE_HEADER));
  const declaredHash = request.headers.get(FILE_HASH_HEADER) ?? "";
  const mediaType =
    request.headers.get("Content-Type") ?? "application/octet-stream";
  const existing = await env.DB.prepare(
    `SELECT artifact_id, revision_version, session_id, path,
            expected_sha256, expected_byte_size, expected_media_type,
            object_key, created_at
       FROM sync_uploads
      WHERE artifact_id = ? AND revision_version = ? AND path = ?`,
  )
    .bind(artifactId, version, path.data)
    .first<SyncUploadRow>();
  if (existing) {
    const matches =
      existing.expected_sha256 === declaredHash &&
      existing.expected_byte_size === declaredSize &&
      existing.expected_media_type === mediaType;
    const object = matches
      ? await env.PRIVATE_ARTIFACTS.head(existing.object_key)
      : null;
    if (
      matches &&
      object &&
      object.size === declaredSize &&
      object.customMetadata?.sha256 === declaredHash &&
      object.customMetadata?.byteSize === String(declaredSize) &&
      (object.httpMetadata?.contentType ?? "application/octet-stream") ===
        mediaType
    ) {
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 204,
          headers: { "X-Panes-Upload-Verified": "true" },
        });
      }
      return new Response(null, { status: 204 });
    }
    if (!matches || (request.method === "HEAD" && object)) {
      return errorResponse(
        409,
        "CONFLICT",
        "Revision file upload conflicts with existing content",
      );
    }
  }
  if (request.method === "HEAD") {
    return errorResponse(404, "NOT_FOUND", "Temporary Revision file not found");
  }

  const bytes = await readBoundedBody(request, MAX_REMOTE_FILE_BYTES);
  if (!bytes)
    return errorResponse(413, "FILE_TOO_LARGE", "Revision file is too large");
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

  const objectKey = temporarySyncObjectKey(
    artifact.cloud_project_id,
    artifactId,
    version,
    sessionId(request),
    path.data,
  );
  await env.PRIVATE_ARTIFACTS.put(objectKey, bytes, {
    httpMetadata: { contentType: mediaType },
    customMetadata: {
      sha256: declaredHash,
      byteSize: String(declaredSize),
      createdAt: new Date().toISOString(),
      artifactId,
      revisionVersion: String(version),
      sessionId: sessionId(request),
      path: path.data,
    },
  });
  const renewedLeaseError = await acquireSyncLease(request, env.DB, artifactId);
  if (renewedLeaseError) return renewedLeaseError;
  await env.DB.prepare(
    `INSERT INTO sync_uploads
      (artifact_id, revision_version, session_id, path, expected_sha256,
       expected_byte_size, expected_media_type, object_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id, revision_version, path) DO UPDATE SET
       session_id = excluded.session_id,
       expected_sha256 = excluded.expected_sha256,
       expected_byte_size = excluded.expected_byte_size,
       expected_media_type = excluded.expected_media_type,
       object_key = excluded.object_key,
       created_at = excluded.created_at`,
  )
    .bind(
      artifactId,
      version,
      sessionId(request),
      path.data,
      declaredHash,
      declaredSize,
      mediaType,
      objectKey,
      new Date().toISOString(),
    )
    .run();
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
  const leaseError = await acquireSyncLease(request, env.DB, artifactId);
  if (leaseError) return leaseError;
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

  let objectFiles: Awaited<ReturnType<typeof verifyUploadedFiles>>;
  try {
    objectFiles = await verifyUploadedFiles(
      env.DB,
      env.PRIVATE_ARTIFACTS,
      artifact.cloud_project_id,
      artifactId,
      version,
      fileEntries,
    );
  } catch {
    return errorResponse(
      409,
      "CONFLICT",
      "Uploaded Revision files do not match the cloud manifest",
    );
  }
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
       SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM local_revisions
           WHERE id = ? AND artifact_id = ? AND committed_at IS NOT NULL
        )
          AND EXISTS (
            SELECT 1 FROM sync_artifacts
             WHERE cloud_artifact_id = ? AND sync_lease_owner = ?
               AND sync_lease_expires_at > ?
          )`,
    ).bind(
      revisionId,
      file.path,
      file.sha256,
      file.byteSize,
      file.mediaType,
      file.objectKey,
      revisionId,
      artifactId,
      artifactId,
      sessionId(request),
      new Date().toISOString(),
    ),
  );
  const commitResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE sync_artifacts
          SET sync_lease_expires_at = ?, updated_at = ?
        WHERE cloud_artifact_id = ? AND sync_lease_owner = ?
          AND sync_lease_expires_at > ?`,
    ).bind(
      new Date(Date.now() + SYNC_LEASE_TTL_MS).toISOString(),
      new Date().toISOString(),
      artifactId,
      sessionId(request),
      new Date().toISOString(),
    ),
    env.DB.prepare(
      `INSERT INTO local_revisions
        (id, artifact_id, version, preview_entry, approved_origins,
          created_at, committed_at, cloud_manifest_key)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM sync_artifacts
           WHERE cloud_artifact_id = ? AND sync_lease_owner = ?
             AND sync_lease_expires_at > ?
        )`,
    ).bind(
      revisionId,
      artifactId,
      version,
      JSON.stringify(revision.preview),
      JSON.stringify(revision.approvedOrigins),
      revision.createdAt,
      committedAt,
      manifestKey,
      artifactId,
      sessionId(request),
      new Date().toISOString(),
    ),
    ...fileStatements,
    env.DB.prepare(
      `DELETE FROM sync_uploads
        WHERE artifact_id = ? AND revision_version = ?
          AND EXISTS (
            SELECT 1 FROM sync_artifacts
             WHERE cloud_artifact_id = ? AND sync_lease_owner = ?
               AND sync_lease_expires_at > ?
          )`,
    ).bind(
      artifactId,
      version,
      artifactId,
      sessionId(request),
      new Date().toISOString(),
    ),
  ]);
  if (
    commitResults[0]?.meta.changes !== 1 ||
    commitResults[1]?.meta.changes !== 1
  ) {
    return errorResponse(
      409,
      "CONFLICT",
      "Sync Artifact lease expired; retry the Sync session",
    );
  }
  const temporaryKeys = objectFiles.flatMap((file) =>
    file.temporaryObjectKey ? [file.temporaryObjectKey] : [],
  );
  if (temporaryKeys.length > 0)
    await env.PRIVATE_ARTIFACTS.delete(temporaryKeys);
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
  db: D1Database,
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
    const committedObjectKey = privateRevisionObjectKey(
      projectId,
      artifactId,
      syncRevisionId(artifactId, version),
      file.path,
    );
    const upload = await db
      .prepare(
        `SELECT artifact_id, revision_version, session_id, path,
                expected_sha256, expected_byte_size, expected_media_type,
                object_key, created_at
           FROM sync_uploads
          WHERE artifact_id = ? AND revision_version = ? AND path = ?`,
      )
      .bind(artifactId, version, file.path)
      .first<SyncUploadRow>();
    const sourceObjectKey = upload?.object_key ?? committedObjectKey;
    if (
      upload &&
      (upload.expected_sha256 !== file.sha256 ||
        upload.expected_byte_size !== file.byteSize ||
        upload.expected_media_type !== file.mediaType)
    ) {
      throw new Error("Revision file upload conflicts with the cloud manifest");
    }
    const object = await bucket.head(sourceObjectKey);
    if (
      !object ||
      object.size !== file.byteSize ||
      object.customMetadata?.sha256 !== file.sha256 ||
      object.customMetadata?.byteSize !== String(file.byteSize) ||
      (object.httpMetadata?.contentType ?? "application/octet-stream") !==
        file.mediaType
    ) {
      throw new Error("Uploaded bytes do not match the cloud manifest");
    }
    if (upload) {
      const body = await bucket.get(sourceObjectKey);
      if (!body || !body.body)
        throw new Error("Uploaded bytes are unavailable");
      await bucket.put(committedObjectKey, body.body, {
        httpMetadata: { contentType: file.mediaType },
        customMetadata: {
          sha256: file.sha256,
          byteSize: String(file.byteSize),
        },
      });
    }
    result.push({
      ...file,
      objectKey: committedObjectKey,
      ...(upload ? { temporaryObjectKey: sourceObjectKey } : {}),
    });
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

interface CreatorCapabilityRow {
  cloud_artifact_id: string;
  cloud_project_id: string;
  slug: string;
  title: string;
  kind: string | null;
  expires_at: string;
  revoked_at: string | null;
}

interface CreatorRevisionRow {
  id: string;
  artifact_id: string;
  version: number;
  preview_entry: string;
  approved_origins: string;
  created_at: string;
  cloud_manifest_key: string;
}

interface CreatorRevisionFileRow {
  path: string;
  sha256: string;
  byte_size: number;
  media_type: string;
  object_key: string;
}

async function readCreatorCapability(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const row = await loadCreatorCapability(env.DB, token);
  if (row instanceof Response) return row;
  if (request.method !== "GET")
    return methodNotAllowed(["GET"], CREATOR_CAPABILITY_HEADERS);
  const revisions = await env.DB.prepare(
    `SELECT id, artifact_id, version, preview_entry, approved_origins,
            created_at, cloud_manifest_key
       FROM local_revisions
      WHERE artifact_id = ? AND committed_at IS NOT NULL
      ORDER BY version DESC`,
  )
    .bind(row.cloud_artifact_id)
    .all<CreatorRevisionRow>();
  const workspaceRevisions = await Promise.all(
    revisions.results.map(async (revisionRow) => {
      const manifestObject = await env.PRIVATE_ARTIFACTS.get(
        revisionRow.cloud_manifest_key,
      );
      if (!manifestObject)
        throw new Error("Committed Revision manifest missing");
      const manifest = cloudManifestSchema.parse(await manifestObject.json());
      if (
        manifest.artifactId !== row.cloud_artifact_id ||
        manifest.projectId !== row.cloud_project_id
      ) {
        throw new Error("Committed Revision manifest identity mismatch");
      }
      const revision = manifest.revisions.find(
        (candidate) => candidate.version === revisionRow.version,
      );
      if (!revision) throw new Error("Committed Revision metadata missing");
      return { ...revision, id: revisionRow.id };
    }),
  );
  return jsonResponse(
    creatorWorkspaceResponseSchema.parse({
      cloudArtifactId: row.cloud_artifact_id,
      cloudProjectId: row.cloud_project_id,
      slug: row.slug,
      title: row.title,
      ...(row.kind ? { kind: row.kind } : {}),
      creatorExpiresAt: row.expires_at,
      revisions: workspaceRevisions,
      ...(await getPublicationSnapshot(env, row.cloud_artifact_id)),
    }),
    200,
    CREATOR_CAPABILITY_HEADERS,
  );
}

async function loadCreatorCapability(
  db: D1Database,
  token: string,
): Promise<CreatorCapabilityRow | Response> {
  const row = await db
    .prepare(
      `SELECT a.cloud_artifact_id, a.cloud_project_id, a.slug, a.title, a.kind,
              l.expires_at, l.revoked_at
         FROM creator_links l
         JOIN sync_artifacts a ON a.cloud_artifact_id = l.artifact_id
        WHERE l.token_hash = ?`,
    )
    .bind(await hashToken(token))
    .first<CreatorCapabilityRow>();
  if (!row)
    return errorResponse(
      404,
      "NOT_FOUND",
      "Creator link not found",
      undefined,
      CREATOR_CAPABILITY_HEADERS,
    );
  if (row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
    return errorResponse(
      410,
      "NOT_FOUND",
      "Creator link is no longer active",
      undefined,
      CREATOR_CAPABILITY_HEADERS,
    );
  }
  return row;
}

async function readCreatorFile(
  request: Request,
  env: Env,
  token: string,
  version: number,
  path: string,
): Promise<Response> {
  const artifact = await loadCreatorCapability(env.DB, token);
  if (artifact instanceof Response) return artifact;
  const row = await env.DB.prepare(
    `SELECT f.object_key, f.sha256, f.media_type, f.byte_size,
            r.preview_entry, r.approved_origins, r.cloud_manifest_key
       FROM revision_files f
       JOIN local_revisions r ON r.id = f.revision_id
      WHERE r.artifact_id = ? AND r.version = ? AND r.committed_at IS NOT NULL
        AND f.path = ?`,
  )
    .bind(artifact.cloud_artifact_id, version, path)
    .first<{
      object_key: string;
      sha256: string;
      media_type: string;
      byte_size: number;
      preview_entry: string;
      approved_origins: string;
      cloud_manifest_key: string;
    }>();
  if (!row) return capabilityFileNotFound();

  const manifestObject = await env.PRIVATE_ARTIFACTS.get(
    row.cloud_manifest_key,
  );
  if (!manifestObject) return capabilityFileNotFound();
  let manifest;
  try {
    const rawManifest = await manifestObject.json();
    validateArchiveManifestPaths(rawManifest);
    manifest = cloudManifestSchema.safeParse(rawManifest);
  } catch {
    return capabilityFileNotFound();
  }
  const manifestRevision = manifest.success
    ? manifest.data.revisions.find((candidate) => candidate.version === version)
    : undefined;
  const manifestFile = manifestRevision?.files.find(
    (candidate) => candidate.kind === "file" && candidate.path === path,
  );
  if (
    !manifestRevision ||
    !manifestFile ||
    manifestFile.kind !== "file" ||
    manifestFile.sha256 !== row.sha256 ||
    manifestFile.byteSize !== row.byte_size ||
    manifestFile.mediaType !== row.media_type
  ) {
    return capabilityFileNotFound();
  }

  const storedPreview = previewEntrySchema.parse(JSON.parse(row.preview_entry));
  const storedOrigins = approvedOriginsSchema.parse(
    JSON.parse(row.approved_origins),
  );
  if (
    JSON.stringify(storedPreview) !==
      JSON.stringify(manifestRevision?.preview) ||
    JSON.stringify(storedOrigins) !==
      JSON.stringify(manifestRevision?.approvedOrigins)
  ) {
    return capabilityFileNotFound();
  }

  const objectMetadata = await env.PRIVATE_ARTIFACTS.head(row.object_key);
  if (
    !objectMetadata ||
    objectMetadata.size !== row.byte_size ||
    objectMetadata.customMetadata?.sha256 !== row.sha256 ||
    objectMetadata.customMetadata?.byteSize !== String(row.byte_size) ||
    objectMetadata.httpMetadata?.contentType !== row.media_type
  )
    return capabilityFileNotFound();
  const object = await env.PRIVATE_ARTIFACTS.get(row.object_key);
  if (!object || !("body" in object) || !object.body)
    return capabilityFileNotFound();
  const preview = manifestRevision.preview;
  const origins = manifestRevision.approvedOrigins;
  const headers = new Headers(CREATOR_CAPABILITY_HEADERS);
  headers.set("Content-Type", normalizePreviewContentType(row.media_type));
  headers.set("Content-Length", String(row.byte_size));
  headers.set(
    "Content-Security-Policy",
    createPreviewCsp(new URL(request.url).origin, origins),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  if (
    request.method === "GET" &&
    new URL(request.url).searchParams.get("download") === "1"
  ) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${safeDownloadName(path)}"`,
    );
  }
  if (!preview.entryPath) return capabilityFileNotFound();
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

async function downloadCreatorRevision(
  request: Request,
  env: Env,
  token: string,
  version: number,
): Promise<Response> {
  const artifact = await loadCreatorCapability(env.DB, token);
  if (artifact instanceof Response) return artifact;
  const revisionRow = await env.DB.prepare(
    `SELECT id, artifact_id, version, preview_entry, approved_origins,
            created_at, cloud_manifest_key
       FROM local_revisions
      WHERE artifact_id = ? AND version = ? AND committed_at IS NOT NULL`,
  )
    .bind(artifact.cloud_artifact_id, version)
    .first<CreatorRevisionRow>();
  if (!revisionRow) return capabilityFileNotFound();

  const manifestObject = await env.PRIVATE_ARTIFACTS.get(
    revisionRow.cloud_manifest_key,
  );
  if (!manifestObject) return capabilityFileNotFound();
  let manifest;
  try {
    const rawManifest = await manifestObject.json();
    validateArchiveManifestPaths(rawManifest);
    manifest = cloudManifestSchema.safeParse(rawManifest);
  } catch {
    return capabilityFileNotFound();
  }
  const revision = manifest.success
    ? manifest.data.revisions.find((candidate) => candidate.version === version)
    : undefined;
  if (
    !manifest.success ||
    manifest.data.projectId !== artifact.cloud_project_id ||
    manifest.data.artifactId !== artifact.cloud_artifact_id ||
    manifest.data.slug !== artifact.slug ||
    manifest.data.title !== artifact.title ||
    !revision
  )
    return capabilityFileNotFound();

  const fileRows = await env.DB.prepare(
    `SELECT path, sha256, byte_size, media_type, object_key
       FROM revision_files WHERE revision_id = ?`,
  )
    .bind(revisionRow.id)
    .all<CreatorRevisionFileRow>();
  try {
    if (
      fileRows.results.some(
        (row) =>
          row.object_key !==
          privateRevisionObjectKey(
            artifact.cloud_project_id,
            artifact.cloud_artifact_id,
            syncRevisionId(artifact.cloud_artifact_id, version),
            row.path,
          ),
      )
    )
      return capabilityFileNotFound();
    const archive = await prepareRevisionArchive({
      bucket: env.PRIVATE_ARTIFACTS,
      revision,
      files: fileRows.results.map((row) => ({
        path: row.path,
        sha256: row.sha256,
        byteSize: row.byte_size,
        mediaType: row.media_type,
        objectKey: row.object_key,
      })),
    });
    return revisionArchiveResponse(
      archive,
      env.PRIVATE_ARTIFACTS,
      revisionZipFilename(artifact.slug, version),
      request.method === "HEAD",
    );
  } catch {
    return capabilityFileNotFound();
  }
}

function capabilityFileNotFound(): Response {
  return errorResponse(
    404,
    "NOT_FOUND",
    "Revision file not found",
    undefined,
    CREATOR_CAPABILITY_HEADERS,
  );
}

function safeDownloadName(path: string): string {
  const name = path.split("/").at(-1) ?? "download";
  return name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120) || "download";
}

async function rotateCreatorLink(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<Response> {
  const artifact = await authenticateSyncOwner(request, env.DB, artifactId);
  if (artifact instanceof Response) return artifact;
  const leaseError = await acquireSyncLease(request, env.DB, artifactId);
  if (leaseError) return leaseError;
  try {
    const body = await parseJsonBody(
      request,
      syncCreatorRotateRequestSchema,
      SYNC_BODY_LIMIT,
    );
    if (!body.ok) return body.response;
    const rotated = await rotateCreatorLinkAfterLease(request, env, artifactId);
    return jsonResponse(
      syncCreatorRotateResponseSchema.parse({
        cloudArtifactId: artifactId,
        creatorToken: rotated.creatorToken,
        creatorUrl: rotated.creatorUrl,
        creatorExpiresAt: rotated.creatorExpiresAt,
      }),
      200,
      CREATOR_CAPABILITY_HEADERS,
    );
  } finally {
    await releaseSyncLeaseByOwner(env.DB, artifactId, sessionId(request));
  }
}

export async function rotateCreatorLinkForInventory(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<InventoryCreatorRotation | Response> {
  const row = await env.DB.prepare(
    `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
            local_artifact_id, slug, title, kind, owner_token_hash,
            creation_idempotency_key, creator_token_hash,
            creator_created_at, creator_expires_at, lifecycle_state
       FROM sync_artifacts WHERE cloud_artifact_id = ?`,
  )
    .bind(artifactId)
    .first<SyncArtifactRow>();
  if (!row) return errorResponse(404, "NOT_FOUND", "Sync Artifact not found");
  if (row.lifecycle_state === "deleting")
    return errorResponse(409, "CONFLICT", "Sync Artifact is being deleted");
  const leaseError = await acquireSyncLease(request, env.DB, artifactId);
  if (leaseError) return leaseError;
  try {
    const rotated = await rotateCreatorLinkAfterLease(request, env, artifactId);
    return {
      creatorUrl: rotated.creatorUrl,
      creatorExpiresAt: rotated.creatorExpiresAt,
    };
  } finally {
    await releaseSyncLeaseByOwner(env.DB, artifactId, sessionId(request));
  }
}

async function rotateCreatorLinkAfterLease(
  request: Request,
  env: Env,
  artifactId: string,
) {
  const creatorToken = `sync-creator-${crypto.randomUUID()}`;
  const tokenHash = await hashToken(creatorToken);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CREATOR_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE creator_links
          SET revoked_at = ?
        WHERE artifact_id = ? AND revoked_at IS NULL`,
    ).bind(createdAt, artifactId),
    env.DB.prepare(
      `INSERT INTO creator_links
        (id, artifact_id, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      `creator_link_${crypto.randomUUID()}`,
      artifactId,
      tokenHash,
      createdAt,
      expiresAt,
    ),
    env.DB.prepare(
      `UPDATE sync_artifacts
          SET creator_token_hash = ?, creator_created_at = ?,
              creator_expires_at = ?, updated_at = ?
        WHERE cloud_artifact_id = ?`,
    ).bind(tokenHash, createdAt, expiresAt, createdAt, artifactId),
  ]);
  return {
    creatorToken,
    creatorUrl: new URL(
      `/creator/${encodeURIComponent(creatorToken)}`,
      request.url,
    ).toString(),
    creatorExpiresAt: expiresAt,
  };
}

async function acquireSyncLease(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response | undefined> {
  const owner = sessionId(request);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + SYNC_LEASE_TTL_MS).toISOString();
  const result = await db
    .prepare(
      `UPDATE sync_artifacts
          SET sync_lease_owner = ?, sync_lease_expires_at = ?, updated_at = ?
        WHERE cloud_artifact_id = ?
          AND (sync_lease_owner IS NULL
           OR sync_lease_expires_at <= ?
            OR sync_lease_owner = ?)
          AND lifecycle_state = 'active'`,
    )
    .bind(owner, expires, now, artifactId, now, owner)
    .run();
  if (result.meta.changes === 1) return undefined;
  return errorResponse(
    409,
    "CONFLICT",
    "Sync Artifact is busy; retry after the current Sync session completes",
  );
}

async function releaseSyncLease(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response> {
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
  const artifact = await authenticateSyncOwner(request, db, artifactId);
  if (artifact instanceof Response) return artifact;
  await db
    .prepare(
      `UPDATE sync_artifacts
          SET sync_lease_owner = NULL, sync_lease_expires_at = NULL
        WHERE cloud_artifact_id = ? AND sync_lease_owner = ?`,
    )
    .bind(artifactId, sessionId(request))
    .run();
  return new Response(null, { status: 204 });
}

async function releaseSyncLeaseByOwner(
  db: D1Database,
  artifactId: string,
  owner: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_artifacts
          SET sync_lease_owner = NULL, sync_lease_expires_at = NULL
        WHERE cloud_artifact_id = ? AND sync_lease_owner = ?`,
    )
    .bind(artifactId, owner)
    .run();
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
              creator_created_at, creator_expires_at, lifecycle_state
         FROM sync_artifacts
        WHERE cloud_artifact_id = ?`,
    )
    .bind(artifactId)
    .first<SyncArtifactRow>();
  if (!row) return errorResponse(404, "NOT_FOUND", "Sync Artifact not found");
  if (row.lifecycle_state === "deleting")
    return errorResponse(409, "CONFLICT", "Sync Artifact is being deleted");
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

function temporarySyncObjectKey(
  projectId: string,
  artifactId: string,
  version: number,
  session: string,
  path: string,
) {
  return [
    "private",
    "tmp",
    encodeKey(projectId),
    encodeKey(artifactId),
    `v${version}`,
    encodeKey(session),
    encodeKey(path),
  ].join("/");
}

function sessionId(request: Request) {
  const value = request.headers.get(SYNC_SESSION_HEADER)?.trim();
  return value && /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : "legacy";
}

export async function cleanupTemporarySyncUploads(
  env: Env,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TEMP_UPLOAD_GRACE_MS).toISOString();
  const cleanupOwner = `cleanup-${crypto.randomUUID()}`;
  const cleanupLeases = new Set<string>();
  // Prevent a concurrent commit from publishing a final object between the
  // reference check and the R2 delete.
  const tracked = await env.DB.prepare(
    `SELECT u.artifact_id, u.revision_version, u.path, u.object_key,
            u.created_at, a.cloud_project_id
       FROM sync_uploads u
       JOIN sync_artifacts a ON a.cloud_artifact_id = u.artifact_id
      WHERE u.created_at < ?
      ORDER BY u.created_at ASC
      LIMIT ?`,
  )
    .bind(cutoff, CLEANUP_BATCH_SIZE)
    .all<
      Pick<
        SyncUploadRow,
        | "artifact_id"
        | "revision_version"
        | "path"
        | "object_key"
        | "created_at"
        | "cloud_project_id"
      >
    >();
  const keys = new Set<string>();
  const deletableTracked = [];
  for (const row of tracked.results) {
    if (!(await acquireCleanupLease(env.DB, row.artifact_id, cleanupOwner))) {
      continue;
    }
    cleanupLeases.add(row.artifact_id);
    const promotedObjectKey = privateRevisionObjectKey(
      row.cloud_project_id,
      row.artifact_id,
      syncRevisionId(row.artifact_id, row.revision_version),
      row.path,
    );
    const references = await env.DB.prepare(
      `SELECT object_key FROM revision_files
        WHERE object_key IN (?, ?)`,
    )
      .bind(row.object_key, promotedObjectKey)
      .all<{ object_key: string }>();
    const referenced = new Set(
      references.results.map((item) => item.object_key),
    );
    if (!referenced.has(row.object_key)) keys.add(row.object_key);
    if (!referenced.has(promotedObjectKey)) keys.add(promotedObjectKey);
    if (!referenced.has(row.object_key) || !referenced.has(promotedObjectKey)) {
      deletableTracked.push({ row, promotedObjectKey });
    }
  }

  const listed = await env.PRIVATE_ARTIFACTS.list({
    prefix: "private/tmp/",
    limit: CLEANUP_BATCH_SIZE,
    include: ["customMetadata"],
  });
  for (const object of listed.objects) {
    const createdAt = object.customMetadata?.createdAt;
    const artifactId = object.customMetadata?.artifactId;
    if (
      createdAt &&
      createdAt < cutoff &&
      artifactId &&
      artifactIdSchema.safeParse(artifactId).success &&
      (await acquireCleanupLease(env.DB, artifactId, cleanupOwner))
    ) {
      cleanupLeases.add(artifactId);
      const referenced = await env.DB.prepare(
        "SELECT 1 AS found FROM revision_files WHERE object_key = ? LIMIT 1",
      )
        .bind(object.key)
        .first<{ found: number }>();
      if (!referenced) keys.add(object.key);
    }
  }
  const boundedKeys = [...keys].slice(0, CLEANUP_BATCH_SIZE);
  if (boundedKeys.length === 0) {
    await releaseCleanupLeases(env.DB, cleanupLeases, cleanupOwner);
    return 0;
  }
  await env.PRIVATE_ARTIFACTS.delete(boundedKeys);
  const deleteStatements = deletableTracked
    .filter(({ row }) => boundedKeys.includes(row.object_key))
    .map(({ row, promotedObjectKey }) =>
      env.DB.prepare(
        `DELETE FROM sync_uploads
          WHERE artifact_id = ? AND revision_version = ? AND path = ?
            AND object_key = ? AND created_at < ?
            AND EXISTS (
              SELECT 1 FROM sync_artifacts
               WHERE cloud_artifact_id = ? AND sync_lease_owner = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM revision_files
               WHERE object_key IN (?, ?)
            )`,
      ).bind(
        row.artifact_id,
        row.revision_version,
        row.path,
        row.object_key,
        cutoff,
        row.artifact_id,
        cleanupOwner,
        row.object_key,
        promotedObjectKey,
      ),
    );
  if (deleteStatements.length > 0) await env.DB.batch(deleteStatements);
  await releaseCleanupLeases(env.DB, cleanupLeases, cleanupOwner);
  return boundedKeys.length;
}

async function acquireCleanupLease(
  db: D1Database,
  artifactId: string,
  owner: string,
) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + SYNC_LEASE_TTL_MS).toISOString();
  const result = await db
    .prepare(
      `UPDATE sync_artifacts
          SET sync_lease_owner = ?, sync_lease_expires_at = ?
        WHERE cloud_artifact_id = ?
          AND (sync_lease_owner IS NULL
           OR sync_lease_expires_at <= ?
            OR sync_lease_owner = ?)
          AND lifecycle_state = 'active'`,
    )
    .bind(owner, expires, artifactId, now, owner)
    .run();
  return result.meta.changes === 1;
}

async function releaseCleanupLeases(
  db: D1Database,
  artifactIds: Set<string>,
  owner: string,
) {
  if (artifactIds.size === 0) return;
  await db.batch(
    [...artifactIds].map((artifactId) =>
      db
        .prepare(
          `UPDATE sync_artifacts
              SET sync_lease_owner = NULL, sync_lease_expires_at = NULL
            WHERE cloud_artifact_id = ? AND sync_lease_owner = ?`,
        )
        .bind(artifactId, owner),
    ),
  );
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

function methodNotAllowed(methods: string[], headers?: HeadersInit): Response {
  return errorResponse(
    405,
    "VALIDATION_ERROR",
    "Method not allowed",
    undefined,
    {
      Allow: methods.join(", "),
      ...headers,
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
