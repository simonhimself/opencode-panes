import {
  creatorPublicationExtendRequestSchema,
  creatorPublicationRequestSchema,
  approvedOriginsSchema,
  cloudManifestSchema,
  ownerTokenSchema,
  publicationSchema,
  previewEntrySchema,
  publicPublicationResponseSchema,
  relativePathSchema,
  type CloudManifest,
  type Publication,
} from "@opencode-panes/contracts";
import {
  createPreviewCsp,
  normalizePreviewContentType,
} from "@opencode-panes/renderers/preview-security";
import { privateRevisionObjectKey } from "./storage";
import {
  prepareRevisionArchive,
  revisionArchiveResponse,
  revisionZipFilename,
  validateArchiveManifestPaths,
} from "./zip";

const PUBLICATION_KEY_VERSION = 1;
const PUBLICATION_LEASE_TTL_MS = 15_000;
const PUBLICATION_BODY_LIMIT = 16 * 1024;
const CAPABILITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

interface CreatorArtifactRow {
  cloud_artifact_id: string;
  cloud_project_id: string;
  slug: string;
  title: string;
  kind: string | null;
  expires_at: string;
  revoked_at: string | null;
  lifecycle_state?: "active" | "deleting";
}

interface PublicationRow {
  id: string;
  artifact_id: string;
  revision_version: number;
  duration_days: number;
  token_hash: string;
  token_ciphertext: string | null;
  token_nonce: string | null;
  encryption_key_version: number | null;
  status: "active" | "expired" | "revoked";
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface PublicationTokenCiphertext {
  id: string;
  artifactId: string;
  tokenCiphertext: string | null;
  tokenNonce: string | null;
  encryptionKeyVersion: number | null;
}

interface RevisionRow {
  id: string;
  version: number;
  committed_at: string | null;
}

interface PublicPublicationRow {
  id: string;
  artifact_id: string;
  revision_version: number;
  status: "active" | "expired" | "revoked";
  expires_at: string;
  cloud_project_id: string;
  slug: string;
  title: string;
  kind: string | null;
  revision_id: string;
  preview_entry: string;
  approved_origins: string;
  cloud_manifest_key: string;
}

interface PublicRevisionFileRow {
  path: string;
  sha256: string;
  byte_size: number;
  media_type: string;
  object_key: string;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export async function routePublicationRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  const publicDownloadMatch = pathname.match(
    /^\/api\/publications\/([^/]+)\/download\.zip$/u,
  );
  if (publicDownloadMatch) {
    const token = decodeSegment(publicDownloadMatch[1]);
    if (!token || !ownerTokenSchema.safeParse(token).success)
      return publicFileNotFound();
    if (request.method !== "GET" && request.method !== "HEAD")
      return methodNotAllowed(["GET", "HEAD"]);
    return publicPublicationDownload(request, env, token);
  }
  const publicFileMatch = pathname.match(
    /^\/api\/publications\/([^/]+)\/files\/(.+)$/u,
  );
  if (publicFileMatch) {
    const token = decodeSegment(publicFileMatch[1]);
    const path = decodePublicPath(publicFileMatch[2]);
    if (!token || !ownerTokenSchema.safeParse(token).success || !path) {
      return publicFileNotFound();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    return publicPublicationFile(request, env, token, path);
  }

  const publicMatch = pathname.match(/^\/api\/publications\/([^/]+)$/u);
  if (publicMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    const token = decodeSegment(publicMatch[1]);
    if (!token || !ownerTokenSchema.safeParse(token).success) return notFound();
    return publicPublicationStatus(token, env);
  }

  const match = new URL(request.url).pathname.match(
    /^\/api\/creator\/([^/]+)\/(?:publication\/)?(publish|republish|extend|unpublish)$/u,
  );
  if (!match) return undefined;
  const token = decodeSegment(match[1]);
  if (!token || !ownerTokenSchema.safeParse(token).success) return notFound();
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const artifact = await authenticateCreator(token, env.DB);
  if (artifact instanceof Response) return artifact;
  const operation = match[2];
  if (operation === "unpublish") return unpublishPublication(env.DB, artifact);

  if (operation === "extend") {
    const body = await parseBody(
      request,
      creatorPublicationExtendRequestSchema,
    );
    if (!body.ok) return body.response;
    return mutatePublication(env, artifact, "extend", body.data);
  }
  const body = await parseBody(request, creatorPublicationRequestSchema);
  if (!body.ok) return body.response;
  return mutatePublication(
    env,
    artifact,
    operation === "extend"
      ? "extend"
      : operation === "republish"
        ? "republish"
        : "publish",
    body.data,
  );
}

export async function getPublicationSnapshot(
  env: Env,
  artifactId: string,
): Promise<{
  publication: Publication | null;
  publicationHistory: Publication[];
}> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE publications
        SET status = 'expired', token_ciphertext = NULL, token_nonce = NULL,
            encryption_key_version = NULL
      WHERE artifact_id = ? AND status = 'active' AND expires_at <= ?`,
  )
    .bind(artifactId, now)
    .run();
  const rows = await env.DB.prepare(
    `SELECT id, artifact_id, revision_version, duration_days, token_hash,
            token_ciphertext, token_nonce, encryption_key_version, status,
            created_at, expires_at, revoked_at
       FROM publications
      WHERE artifact_id = ?
      ORDER BY created_at DESC`,
  )
    .bind(artifactId)
    .all<PublicationRow>();
  const history = await Promise.all(
    rows.results.map((row) => publicationView(row)),
  );
  return {
    publication: history.find((item) => item.status === "active") ?? null,
    publicationHistory: history,
  };
}

export async function mutatePublicationForInventory(
  env: Env,
  artifactId: string,
  operation: "extend" | "republish" | "unpublish",
  body?: {
    revisionVersion?: number | undefined;
    durationDays?: 1 | 7 | 30 | undefined;
  },
): Promise<Response> {
  const artifact = await env.DB.prepare(
    `SELECT a.cloud_artifact_id, a.cloud_project_id, a.slug, a.title, a.kind,
            l.expires_at, l.revoked_at, a.lifecycle_state
       FROM sync_artifacts a
       LEFT JOIN creator_links l ON l.artifact_id = a.cloud_artifact_id
      WHERE a.cloud_artifact_id = ?
      ORDER BY l.created_at DESC LIMIT 1`,
  )
    .bind(artifactId)
    .first<CreatorArtifactRow>();
  if (!artifact) return notFound("Sync Artifact not found");
  if (artifact.lifecycle_state === "deleting")
    return conflict("Sync Artifact is being deleted");
  if (operation === "unpublish") return unpublishPublication(env.DB, artifact);
  if (!body?.durationDays) return validation("Request validation failed");
  return mutatePublication(env, artifact, operation, {
    ...(body.revisionVersion === undefined
      ? {}
      : { revisionVersion: body.revisionVersion }),
    durationDays: body.durationDays,
  });
}

async function authenticateCreator(
  token: string,
  db: D1Database,
): Promise<CreatorArtifactRow | Response> {
  const row = await db
    .prepare(
      `SELECT a.cloud_artifact_id, a.cloud_project_id, a.slug, a.title, a.kind,
              l.expires_at, l.revoked_at, a.lifecycle_state
         FROM creator_links l
         JOIN sync_artifacts a ON a.cloud_artifact_id = l.artifact_id
        WHERE l.token_hash = ?`,
    )
    .bind(await hashToken(token))
    .first<CreatorArtifactRow>();
  if (!row) return notFound("Creator link not found");
  if (row.lifecycle_state === "deleting")
    return conflict("Sync Artifact is being deleted");
  if (row.revoked_at || Date.parse(row.expires_at) <= Date.now())
    return gone("Creator link is no longer active");
  return row;
}

async function mutatePublication(
  env: Env,
  artifact: CreatorArtifactRow,
  operation: "publish" | "republish" | "extend",
  body: { revisionVersion?: number; durationDays: 1 | 7 | 30 },
): Promise<Response> {
  const leaseOwner = `publication-${crypto.randomUUID()}`;
  const lease = await acquirePublicationLease(
    env.DB,
    artifact.cloud_artifact_id,
    leaseOwner,
  );
  if (!lease) return conflict("Publication is busy; retry this action");
  try {
    if (operation === "extend")
      return extendPublication(env, artifact, body.durationDays);

    const revision = await env.DB.prepare(
      `SELECT id, version, committed_at FROM local_revisions
        WHERE artifact_id = ? AND version = ? AND committed_at IS NOT NULL`,
    )
      .bind(artifact.cloud_artifact_id, body.revisionVersion)
      .first<RevisionRow>();
    if (!revision) return notFound("Revision not found");

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const active = await activePublication(env.DB, artifact.cloud_artifact_id);
    if (
      operation === "publish" &&
      active &&
      Date.parse(active.expires_at) > nowDate.getTime() &&
      active.revision_version === revision.version
    ) {
      return publicationResponse(active, 200);
    }

    const publicationId = `publication_${crypto.randomUUID()}`;
    const token = randomToken();
    const encrypted = await encryptToken(
      env,
      token,
      artifact.cloud_artifact_id,
      publicationId,
    );
    const expiresAt = new Date(
      nowDate.getTime() + body.durationDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const statements = [
      env.DB.prepare(
        `UPDATE publications
            SET status = 'expired', token_ciphertext = NULL, token_nonce = NULL,
                encryption_key_version = NULL
          WHERE artifact_id = ? AND status = 'active' AND expires_at <= ?`,
      ).bind(artifact.cloud_artifact_id, now),
      env.DB.prepare(
        `UPDATE publications
            SET status = 'revoked', revoked_at = ?, token_ciphertext = NULL,
                token_nonce = NULL, encryption_key_version = NULL
          WHERE artifact_id = ? AND status = 'active'`,
      ).bind(now, artifact.cloud_artifact_id),
      env.DB.prepare(
        `INSERT INTO publications
          (id, artifact_id, revision_version, duration_days, token_hash,
           token_ciphertext, token_nonce, encryption_key_version, status,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(
        publicationId,
        artifact.cloud_artifact_id,
        revision.version,
        body.durationDays,
        await hashToken(token),
        encrypted.ciphertext,
        encrypted.nonce,
        PUBLICATION_KEY_VERSION,
        now,
        expiresAt,
      ),
    ];
    await env.DB.batch(statements);
    const created = await env.DB.prepare(
      `SELECT id, artifact_id, revision_version, duration_days, token_hash,
              token_ciphertext, token_nonce, encryption_key_version, status,
              created_at, expires_at, revoked_at
         FROM publications WHERE id = ?`,
    )
      .bind(publicationId)
      .first<PublicationRow>();
    if (!created) throw new Error("Created Publication was not found");
    return publicationResponse(created, 201);
  } finally {
    await releasePublicationLease(
      env.DB,
      artifact.cloud_artifact_id,
      leaseOwner,
    );
  }
}

async function extendPublication(
  env: Env,
  artifact: CreatorArtifactRow,
  durationDays: 1 | 7 | 30,
): Promise<Response> {
  const active = await activePublication(env.DB, artifact.cloud_artifact_id);
  if (!active || Date.parse(active.expires_at) <= Date.now()) {
    if (active)
      await expirePublication(env.DB, active.id, new Date().toISOString());
    return conflict("Publication is no longer active; use Republish instead");
  }
  const expiresAt = new Date(
    Date.parse(active.expires_at) + durationDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  await env.DB.prepare(
    `UPDATE publications SET expires_at = ?, duration_days = ?
      WHERE id = ? AND status = 'active' AND expires_at > ?`,
  )
    .bind(expiresAt, durationDays, active.id, new Date().toISOString())
    .run();
  const updated = await env.DB.prepare(
    `SELECT id, artifact_id, revision_version, duration_days, token_hash,
            token_ciphertext, token_nonce, encryption_key_version, status,
            created_at, expires_at, revoked_at
       FROM publications WHERE id = ?`,
  )
    .bind(active.id)
    .first<PublicationRow>();
  if (!updated || updated.status !== "active")
    return conflict("Publication is no longer active; use Republish instead");
  return publicationResponse(updated, 200);
}

async function unpublishPublication(
  db: D1Database,
  artifact: CreatorArtifactRow,
): Promise<Response> {
  const now = new Date().toISOString();
  const leaseOwner = `publication-${crypto.randomUUID()}`;
  if (
    !(await acquirePublicationLease(db, artifact.cloud_artifact_id, leaseOwner))
  )
    return conflict("Publication is busy; retry this action");
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE publications SET status = 'expired', token_ciphertext = NULL,
            token_nonce = NULL, encryption_key_version = NULL
          WHERE artifact_id = ? AND status = 'active' AND expires_at <= ?`,
        )
        .bind(artifact.cloud_artifact_id, now),
      db
        .prepare(
          `UPDATE publications SET status = 'revoked', revoked_at = ?,
            token_ciphertext = NULL, token_nonce = NULL, encryption_key_version = NULL
          WHERE artifact_id = ? AND status = 'active'`,
        )
        .bind(now, artifact.cloud_artifact_id),
    ]);
    return new Response(null, { status: 204, headers: CAPABILITY_HEADERS });
  } finally {
    await releasePublicationLease(db, artifact.cloud_artifact_id, leaseOwner);
  }
}

async function activePublication(db: D1Database, artifactId: string) {
  return db
    .prepare(
      `SELECT id, artifact_id, revision_version, duration_days, token_hash,
              token_ciphertext, token_nonce, encryption_key_version, status,
              created_at, expires_at, revoked_at
         FROM publications WHERE artifact_id = ? AND status = 'active' LIMIT 1`,
    )
    .bind(artifactId)
    .first<PublicationRow>();
}

async function publicationView(row: PublicationRow): Promise<Publication> {
  const status =
    row.status === "active" && Date.parse(row.expires_at) <= Date.now()
      ? "expired"
      : row.status;
  return publicationSchema.parse({
    id: row.id,
    artifactId: row.artifact_id,
    revisionVersion: row.revision_version,
    durationDays: row.duration_days,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  });
}

async function publicationResponse(row: PublicationRow, status: number) {
  return jsonResponse(
    publicationSchema.parse({
      id: row.id,
      artifactId: row.artifact_id,
      revisionVersion: row.revision_version,
      durationDays: row.duration_days,
      status: "active",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }),
    status,
  );
}

async function publicPublicationStatus(token: string, env: Env) {
  const lookup = await lookupPublicPublication(token, env.DB);
  if (!lookup) return notFound();
  if (lookup.status !== "active") return gone();
  if (Date.parse(lookup.expires_at) <= Date.now()) {
    await expirePublication(env.DB, lookup.id, new Date().toISOString());
    return gone();
  }

  const workspace = await publicWorkspace(env, lookup);
  if (!workspace) return notFound();
  return jsonResponse(workspace);
}

async function lookupPublicPublication(
  token: string,
  db: D1Database,
): Promise<PublicPublicationRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.artifact_id, p.revision_version, p.status, p.expires_at,
              a.cloud_project_id, a.slug, a.title, a.kind,
              r.id AS revision_id, r.preview_entry, r.approved_origins,
              r.cloud_manifest_key
         FROM publications p
         JOIN sync_artifacts a ON a.cloud_artifact_id = p.artifact_id
         JOIN local_revisions r
           ON r.artifact_id = p.artifact_id
          AND r.version = p.revision_version
          AND r.committed_at IS NOT NULL
         WHERE p.token_hash = ? AND a.lifecycle_state = 'active'
        ORDER BY p.created_at DESC LIMIT 1`,
    )
    .bind(await hashToken(token))
    .first<PublicPublicationRow>();
}

async function publicWorkspace(env: Env, publication: PublicPublicationRow) {
  const manifestObject = await env.PRIVATE_ARTIFACTS.get(
    publication.cloud_manifest_key,
  );
  if (!manifestObject) return undefined;

  let manifest;
  try {
    manifest = cloudManifestSchema.parse(await manifestObject.json());
  } catch {
    return undefined;
  }
  if (
    manifest.projectId !== publication.cloud_project_id ||
    manifest.artifactId !== publication.artifact_id ||
    manifest.slug !== publication.slug ||
    manifest.title !== publication.title ||
    (manifest.kind ?? null) !== publication.kind
  )
    return undefined;

  const manifestRevision = manifest.revisions.find(
    (revision) => revision.version === publication.revision_version,
  );
  if (!manifestRevision) return undefined;

  let preview;
  let approvedOrigins;
  try {
    preview = previewEntrySchema.parse(JSON.parse(publication.preview_entry));
    approvedOrigins = approvedOriginsSchema.parse(
      JSON.parse(publication.approved_origins),
    );
  } catch {
    return undefined;
  }
  if (
    JSON.stringify(preview) !== JSON.stringify(manifestRevision.preview) ||
    JSON.stringify(approvedOrigins) !==
      JSON.stringify(manifestRevision.approvedOrigins)
  )
    return undefined;

  const rows = await env.DB.prepare(
    `SELECT path, sha256, byte_size, media_type, object_key
       FROM revision_files WHERE revision_id = ?`,
  )
    .bind(publication.revision_id)
    .all<PublicRevisionFileRow>();
  const manifestFiles = manifestRevision.files.filter(
    (file) => file.kind === "file",
  );
  if (rows.results.length !== manifestFiles.length) return undefined;
  for (const file of manifestFiles) {
    const row = rows.results.find((candidate) => candidate.path === file.path);
    if (
      !row ||
      row.sha256 !== file.sha256 ||
      row.byte_size !== file.byteSize ||
      row.media_type !== file.mediaType ||
      row.object_key !==
        privateRevisionObjectKey(
          publication.cloud_project_id,
          publication.artifact_id,
          publicRevisionId(
            publication.artifact_id,
            publication.revision_version,
          ),
          file.path,
        )
    )
      return undefined;
  }

  return publicPublicationResponseSchema.parse({
    status: "active",
    expiresAt: publication.expires_at,
    artifact: {
      slug: publication.slug,
      title: publication.title,
      ...(publication.kind ? { kind: publication.kind } : {}),
    },
    revision: {
      version: manifestRevision.version,
      preview: manifestRevision.preview,
      approvedOrigins: manifestRevision.approvedOrigins,
      files: manifestRevision.files.map((file) =>
        file.kind === "file"
          ? {
              kind: "file" as const,
              path: file.path,
              byteSize: file.byteSize,
              mediaType: file.mediaType,
            }
          : { kind: "directory" as const, path: file.path, byteSize: 0 },
      ),
      createdAt: manifestRevision.createdAt,
    },
  });
}

async function publicPublicationFile(
  request: Request,
  env: Env,
  token: string,
  path: string,
) {
  const publication = await lookupPublicPublication(token, env.DB);
  if (!publication) return publicFileNotFound();
  if (publication.status !== "active") return gone();
  if (Date.parse(publication.expires_at) <= Date.now()) {
    await expirePublication(env.DB, publication.id, new Date().toISOString());
    return gone();
  }

  const workspace = await publicWorkspace(env, publication);
  const file = workspace?.revision.files.find(
    (candidate) => candidate.kind === "file" && candidate.path === path,
  );
  if (!workspace || !file || file.kind !== "file") return publicFileNotFound();

  const manifestObject = await env.PRIVATE_ARTIFACTS.get(
    publication.cloud_manifest_key,
  );
  let manifestFile:
    | Extract<
        CloudManifest["revisions"][number]["files"][number],
        { kind: "file" }
      >
    | undefined;
  try {
    const manifest = cloudManifestSchema.parse(await manifestObject?.json());
    manifestFile = manifest.revisions
      .find((revision) => revision.version === publication.revision_version)
      ?.files.find(
        (candidate) => candidate.kind === "file" && candidate.path === path,
      ) as typeof manifestFile;
  } catch {
    return publicFileNotFound();
  }
  if (!manifestFile) return publicFileNotFound();

  const row = await env.DB.prepare(
    `SELECT path, sha256, byte_size, media_type, object_key
       FROM revision_files WHERE revision_id = ? AND path = ?`,
  )
    .bind(publication.revision_id, path)
    .first<PublicRevisionFileRow>();
  if (!row || row.sha256 !== manifestFile.sha256) return publicFileNotFound();

  const expectedObjectKey = privateRevisionObjectKey(
    publication.cloud_project_id,
    publication.artifact_id,
    publicRevisionId(publication.artifact_id, publication.revision_version),
    path,
  );
  if (
    row.object_key !== expectedObjectKey ||
    row.byte_size !== file.byteSize ||
    row.media_type !== file.mediaType
  )
    return publicFileNotFound();

  const metadata = await env.PRIVATE_ARTIFACTS.head(row.object_key);
  if (
    !metadata ||
    metadata.size !== row.byte_size ||
    metadata.customMetadata?.sha256 !== row.sha256 ||
    metadata.customMetadata?.byteSize !== String(row.byte_size) ||
    (metadata.httpMetadata?.contentType ?? "application/octet-stream") !==
      row.media_type
  )
    return publicFileNotFound();
  const object =
    request.method === "HEAD"
      ? undefined
      : await env.PRIVATE_ARTIFACTS.get(row.object_key);
  if (request.method === "GET" && !object?.body) return publicFileNotFound();

  const headers = new Headers(CAPABILITY_HEADERS);
  headers.set("Content-Type", normalizePreviewContentType(row.media_type));
  headers.set("Content-Length", String(row.byte_size));
  headers.set(
    "Content-Security-Policy",
    createPreviewCsp(
      new URL(request.url).origin,
      workspace.revision.approvedOrigins,
    ),
  );
  if (
    request.method === "GET" &&
    new URL(request.url).searchParams.get("download") === "1"
  ) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${safeDownloadName(path)}"`,
    );
  }
  return new Response(request.method === "HEAD" ? null : object?.body, {
    status: 200,
    headers,
  });
}

async function publicPublicationDownload(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const publication = await lookupPublicPublication(token, env.DB);
  if (!publication) return publicFileNotFound();
  if (publication.status !== "active") return gone();
  if (Date.parse(publication.expires_at) <= Date.now()) {
    await expirePublication(env.DB, publication.id, new Date().toISOString());
    return gone();
  }

  const manifestObject = await env.PRIVATE_ARTIFACTS.get(
    publication.cloud_manifest_key,
  );
  let manifest;
  try {
    const rawManifest = await manifestObject?.json();
    validateArchiveManifestPaths(rawManifest);
    manifest = cloudManifestSchema.safeParse(rawManifest);
  } catch {
    return publicFileNotFound();
  }
  const revision = manifest.success
    ? manifest.data.revisions.find(
        (candidate) => candidate.version === publication.revision_version,
      )
    : undefined;
  if (
    !manifest.success ||
    manifest.data.projectId !== publication.cloud_project_id ||
    manifest.data.artifactId !== publication.artifact_id ||
    manifest.data.slug !== publication.slug ||
    manifest.data.title !== publication.title ||
    (manifest.data.kind ?? null) !== publication.kind ||
    !revision
  )
    return publicFileNotFound();

  const rows = await env.DB.prepare(
    `SELECT path, sha256, byte_size, media_type, object_key
       FROM revision_files WHERE revision_id = ?`,
  )
    .bind(publication.revision_id)
    .all<PublicRevisionFileRow>();
  try {
    if (
      rows.results.some(
        (row) =>
          row.object_key !==
          privateRevisionObjectKey(
            publication.cloud_project_id,
            publication.artifact_id,
            publicRevisionId(
              publication.artifact_id,
              publication.revision_version,
            ),
            row.path,
          ),
      )
    )
      return publicFileNotFound();
    const archive = await prepareRevisionArchive({
      bucket: env.PRIVATE_ARTIFACTS,
      revision,
      files: rows.results.map((row) => ({
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
      revisionZipFilename(publication.slug, publication.revision_version),
      request.method === "HEAD",
    );
  } catch {
    return publicFileNotFound();
  }
}

function publicRevisionId(artifactId: string, version: number): string {
  return `sync_revision_${artifactId}_${version}`;
}

function decodePublicPath(value: string | undefined): string | undefined {
  if (!value || /%(?:2f|5c)/iu.test(value)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (/%[0-9a-f]{2}/iu.test(decoded) || decoded.includes("\\"))
    return undefined;
  const segments = decoded.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    return undefined;
  const parsed = relativePathSchema.safeParse(decoded);
  return parsed.success && parsed.data === decoded ? parsed.data : undefined;
}

async function acquirePublicationLease(
  db: D1Database,
  artifactId: string,
  owner: string,
) {
  const now = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + PUBLICATION_LEASE_TTL_MS,
  ).toISOString();
  const result = await db
    .prepare(
      `UPDATE sync_artifacts SET publication_lease_owner = ?,
          publication_lease_expires_at = ?
        WHERE cloud_artifact_id = ? AND (publication_lease_owner IS NULL
          OR publication_lease_expires_at <= ? OR publication_lease_owner = ?)`,
    )
    .bind(owner, expiresAt, artifactId, now, owner)
    .run();
  return result.meta.changes === 1;
}

async function releasePublicationLease(
  db: D1Database,
  artifactId: string,
  owner: string,
) {
  await db
    .prepare(
      `UPDATE sync_artifacts SET publication_lease_owner = NULL,
          publication_lease_expires_at = NULL
        WHERE cloud_artifact_id = ? AND publication_lease_owner = ?`,
    )
    .bind(artifactId, owner)
    .run();
}

async function expirePublication(db: D1Database, id: string, now: string) {
  await db
    .prepare(
      `UPDATE publications SET status = 'expired', token_ciphertext = NULL,
          token_nonce = NULL, encryption_key_version = NULL
        WHERE id = ? AND status = 'active' AND expires_at <= ?`,
    )
    .bind(id, now)
    .run();
}

async function encryptToken(
  env: Env,
  token: string,
  artifactId: string,
  publicationId: string,
) {
  const key = await encryptionKey(env, "encrypt");
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce.buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(aad(artifactId, publicationId))
        .buffer as ArrayBuffer,
    },
    key,
    new TextEncoder().encode(token).buffer as ArrayBuffer,
  );
  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    nonce: bytesToHex(nonce),
  };
}

export async function decryptPublicationToken(
  env: Env,
  row: PublicationTokenCiphertext,
): Promise<string> {
  if (
    row.encryptionKeyVersion !== PUBLICATION_KEY_VERSION ||
    !row.tokenCiphertext ||
    !row.tokenNonce
  )
    throw new Error("Publication token ciphertext is unavailable");
  const nonce = hexToBytes(row.tokenNonce);
  if (!nonce || nonce.byteLength !== 12)
    throw new Error("Publication nonce is malformed");
  const key = await encryptionKey(env, "decrypt");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce.buffer as ArrayBuffer,
        additionalData: new TextEncoder().encode(aad(row.artifactId, row.id))
          .buffer as ArrayBuffer,
      },
      key,
      decodeBase64(row.tokenCiphertext).buffer as ArrayBuffer,
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!ownerTokenSchema.safeParse(token).success)
      throw new Error("Publication token is malformed");
    return token;
  } catch {
    throw new Error("Publication token authentication failed");
  }
}

async function encryptionKey(env: Env, usage: "encrypt" | "decrypt") {
  const value = env.PUBLICATION_ENCRYPTION_KEY_V1;
  if (!value) throw new Error("Publication encryption key is not configured");
  const bytes = decodeKey(value);
  if (!bytes || bytes.byteLength !== 32)
    throw new Error("Publication encryption key is malformed");
  return crypto.subtle.importKey(
    "raw",
    bytes.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function decodeKey(value: string): Uint8Array | undefined {
  if (/^[0-9a-f]{64}$/u.test(value)) return hexToBytes(value);
  try {
    const bytes = decodeBase64(value);
    return bytes.byteLength === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function aad(artifactId: string, publicationId: string) {
  return `opencode-panes/publication/${artifactId}/${publicationId}/key-v${PUBLICATION_KEY_VERSION}`;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function hashToken(token: string) {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
}

async function parseBody<T>(
  request: Request,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): Promise<Parsed<T>> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return {
      ok: false,
      response: validation("Content-Type must be application/json"),
    };
  try {
    const contentLength = Number(request.headers.get("Content-Length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > PUBLICATION_BODY_LIMIT
    )
      return { ok: false, response: validation("Request is too large") };
    const body = await readBoundedBody(request, PUBLICATION_BODY_LIMIT);
    if (!body)
      return { ok: false, response: validation("Request is too large") };
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, data: parsed.data as T };
  } catch {
    // Fall through to the generic validation response.
  }
  return { ok: false, response: validation("Request validation failed") };
}

async function readBoundedBody(request: Request, maxBytes: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Request body exceeds the publication limit");
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CAPABILITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function validation(message: string) {
  return jsonResponse({ error: { code: "VALIDATION_ERROR", message } }, 400);
}
function conflict(message: string) {
  return jsonResponse({ error: { code: "CONFLICT", message } }, 409);
}
function notFound(message = "Publication not found") {
  return jsonResponse({ error: { code: "NOT_FOUND", message } }, 404);
}
function publicFileNotFound() {
  return jsonResponse(
    { error: { code: "NOT_FOUND", message: "File not found" } },
    404,
  );
}
function safeDownloadName(path: string): string {
  const name = path.split("/").at(-1) ?? "download";
  return name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120) || "download";
}
function gone(message = "Publication is no longer active") {
  return jsonResponse({ error: { code: "NOT_FOUND", message } }, 410);
}
function methodNotAllowed(methods: string[]) {
  const response = jsonResponse(
    { error: { code: "VALIDATION_ERROR", message: "Method not allowed" } },
    405,
  );
  response.headers.set("Allow", methods.join(", "));
  return response;
}

function decodeSegment(value: string | undefined) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) return undefined;
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}
function encodeBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
