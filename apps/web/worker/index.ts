import {
  filePathSchema,
  shareRequestSchema,
  uploadRequestSchema,
  type ArtifactLibrary,
  type ArtifactShare,
  type ArtifactVersion,
  type LibraryArtifact,
  type PublicArtifact,
  type UploadRequest,
  type UploadResult,
  type UploadSession,
} from "@opencode-panes/contracts";
import { verifyAccessRequest } from "./access";
import {
  authorizeUpload,
  devOwner,
  encodePath,
  fileHeaders,
  HttpError,
  previewToken,
  previewVersion,
  readBytes,
  readJson,
  requireSameOrigin,
  sha256,
} from "./security";

interface UploadRow {
  id: string;
  artifact_id: string;
  manifest: string;
  deleted_at: string | null;
}
interface VersionRow extends UploadRow {
  number: number;
  created_at: string;
}
interface ShareRow {
  token: string;
  version_id: string;
  expires_at: string | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      // Never log the request URL or raw exceptions: both can contain capabilities.
      response = Response.json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Internal server error",
        },
        { status: error instanceof HttpError ? error.status : 500 },
      );
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // Tombstones are retained to deny stale uploads and retry interrupted cleanup.
    const deleted = await env.DB.prepare(
      "SELECT id FROM library_artifacts WHERE deleted_at IS NOT NULL",
    ).all<{ id: string }>();
    for (const artifact of deleted.results)
      await purgeObjects(env, artifact.id);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/" && (method === "GET" || method === "HEAD"))
    return Response.redirect(`${url.origin}/inventory`, 302);

  if (path === "/api/uploads" || path.startsWith("/api/uploads/")) {
    authorizeUpload(request, env);
    if (path === "/api/uploads" && method === "POST")
      return startUpload(request, env);
    const file = /^\/api\/uploads\/([a-f0-9-]{36})\/files\/(.+)$/u.exec(path);
    if (file && method === "PUT")
      return putFile(request, env, file[1]!, decodeFilePath(file[2]!));
    const commit = /^\/api\/uploads\/([a-f0-9-]{36})\/commit$/u.exec(path);
    if (commit && method === "POST") {
      await readBytes(request, 0);
      return commitUpload(env, commit[1]!, url.origin);
    }
    throw new HttpError(404, "Not found");
  }

  if (
    path === "/inventory" ||
    path.startsWith("/inventory/") ||
    path === "/api/library" ||
    path.startsWith("/api/library/")
  ) {
    if (!devOwner(request, env)) {
      const access = await verifyAccessRequest(request, env);
      if (!access.ok)
        throw new HttpError(
          access.status,
          access.status === 503
            ? "Owner authentication unavailable"
            : "Unauthorized",
        );
    }
    if (method !== "GET" && method !== "HEAD") requireSameOrigin(request);
    if (
      path.startsWith("/inventory") &&
      (method === "GET" || method === "HEAD")
    )
      return assets(request, env);
    if (path === "/api/library" && method === "GET")
      return Response.json(await library(env, url.origin));
    const artifact =
      /^\/api\/library\/artifacts\/([a-f0-9-]{36})(\/share)?$/u.exec(path);
    if (artifact) {
      const id = artifact[1]!;
      if (!artifact[2] && method === "DELETE") {
        await readBytes(request, 0);
        // Deny reads and new commits atomically before touching object storage.
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE library_artifacts SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?",
          ).bind(new Date().toISOString(), id),
          env.DB.prepare(
            "DELETE FROM library_shares WHERE artifact_id = ?",
          ).bind(id),
        ]);
        await purgeObjects(env, id);
        return new Response(null, { status: 204 });
      }
      if (!artifact[2] && method === "GET") {
        const found = (await library(env, url.origin, id)).artifacts[0];
        if (!found) throw new HttpError(404, "Not found");
        return Response.json(found);
      }
      if (artifact[2] && method === "PUT")
        return shareArtifact(request, env, id);
      if (artifact[2] && method === "DELETE") {
        await readBytes(request, 0);
        await env.DB.prepare("DELETE FROM library_shares WHERE artifact_id = ?")
          .bind(id)
          .run();
        return new Response(null, { status: 204 });
      }
    }
    throw new HttpError(404, "Not found");
  }

  const share =
    /^\/api\/shares\/([a-f0-9]{64})(?:\/versions\/([a-f0-9-]{36})\/files\/(.+))?$/u.exec(
      path,
    );
  if (share && (method === "GET" || method === "HEAD")) {
    const selected = await publicVersion(env, share[1]!);
    if (share[2]) {
      if (share[2] !== selected.id) throw new HttpError(404, "Not found");
      return serveFile(
        env,
        selected,
        decodeFilePath(share[3]!),
        `${url.origin}/api/shares/${share[1]}/versions/${selected.id}/files/`,
        method === "HEAD",
      );
    }
    const manifest = uploadRequestSchema.parse(JSON.parse(selected.manifest));
    const body: PublicArtifact = {
      title: manifest.title,
      version: versionInfo(
        selected,
        `${url.origin}/api/shares/${share[1]}/versions/${selected.id}/files/${encodePath(manifest.entryPath)}`,
      ),
      expiresAt: selected.expires_at,
    };
    return Response.json(body);
  }
  const preview = /^\/api\/previews\/([^/]+)\/files\/(.+)$/u.exec(path);
  if (preview && (method === "GET" || method === "HEAD")) {
    const version = await getVersion(env, previewVersion(preview[1]!, env));
    return serveFile(
      env,
      version,
      decodeFilePath(preview[2]!),
      `${url.origin}/api/previews/${preview[1]}/files/`,
      method === "HEAD",
    );
  }
  if (/^\/s\/[^/]+$/u.test(path) && (method === "GET" || method === "HEAD"))
    return assets(request, env);
  // No legacy API or creator route falls through to the SPA.
  throw new HttpError(404, "Not found");
}

async function assets(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) throw new HttpError(503, "Viewer assets unavailable");
  return env.ASSETS.fetch(request);
}

function decodeFilePath(encoded: string): string {
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, "Invalid path");
  }
  if (!filePathSchema.safeParse(path).success)
    throw new HttpError(400, "Invalid path");
  return path;
}

async function getUpload(env: Env, id: string): Promise<UploadRow> {
  const row = await env.DB.prepare(
    `SELECT u.*, a.deleted_at FROM library_uploads u
    JOIN library_artifacts a ON a.id = u.artifact_id WHERE u.id = ?`,
  )
    .bind(id)
    .first<UploadRow>();
  if (!row) throw new HttpError(404, "Not found");
  if (row.deleted_at) throw new HttpError(410, "Artifact deleted");
  return row;
}

async function startUpload(request: Request, env: Env): Promise<Response> {
  const parsed = uploadRequestSchema.safeParse(
    await readJson(request, 1024 * 1024),
  );
  if (!parsed.success) throw new HttpError(400, "Invalid upload manifest");
  const manifest = parsed.data;
  // Stable ordering treats equivalent JSON requests as identical retries.
  manifest.files.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const serialized = JSON.stringify(manifest);
  const existing = await env.DB.prepare(
    "SELECT id, manifest FROM library_uploads WHERE idempotency_key = ?",
  )
    .bind(manifest.idempotencyKey)
    .first<{ id: string; manifest: string }>();
  if (!existing) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO library_projects (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
      ).bind(manifest.project.id, manifest.project.name),
      env.DB.prepare(
        "INSERT INTO library_artifacts (id, project_id, artifact_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      ).bind(crypto.randomUUID(), manifest.project.id, manifest.artifactKey),
      env.DB.prepare(
        `INSERT INTO library_uploads (id, artifact_id, idempotency_key, manifest, created_at)
        SELECT ?, id, ?, ?, ? FROM library_artifacts WHERE project_id = ? AND artifact_key = ? AND deleted_at IS NULL
        ON CONFLICT(idempotency_key) DO NOTHING`,
      ).bind(
        crypto.randomUUID(),
        manifest.idempotencyKey,
        serialized,
        new Date().toISOString(),
        manifest.project.id,
        manifest.artifactKey,
      ),
    ]);
  }
  const session = await env.DB.prepare(
    "SELECT id, manifest FROM library_uploads WHERE idempotency_key = ?",
  )
    .bind(manifest.idempotencyKey)
    .first<{ id: string; manifest: string }>();
  if (!session) throw new HttpError(409, "Upload could not be started");
  const upload = await getUpload(env, session.id);
  if (session.manifest !== serialized)
    throw new HttpError(
      409,
      "Idempotency key already used with a different manifest",
    );
  const complete = !!(await env.DB.prepare(
    "SELECT id FROM library_versions WHERE id = ?",
  )
    .bind(upload.id)
    .first());
  const result: UploadSession = {
    uploadId: upload.id,
    artifactId: upload.artifact_id,
    complete,
    dashboardUrl: dashboard(new URL(request.url).origin, upload.artifact_id),
  };
  return Response.json(result);
}

function objectKey(upload: UploadRow, path: string): string {
  return `library/${upload.artifact_id}/${upload.id}/${path}`;
}

async function putFile(
  request: Request,
  env: Env,
  id: string,
  path: string,
): Promise<Response> {
  const upload = await getUpload(env, id);
  const manifest: UploadRequest = JSON.parse(upload.manifest);
  const file = manifest.files.find((item) => item.path === path);
  if (!file) throw new HttpError(404, "File not in manifest");
  const bytes = await readBytes(request, file.size);
  if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256)
    throw new HttpError(400, "File integrity mismatch");
  const key = objectKey(upload, path);
  // Every write, including in-flight retries racing commit, is create-only.
  // A committed object can never be overwritten with new or partial bytes.
  const stored = await env.PRIVATE_ARTIFACTS.put(key, bytes, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    sha256: file.sha256,
  });
  if (!stored) {
    const current = await env.PRIVATE_ARTIFACTS.head(key);
    if (
      !current ||
      current.size !== file.size ||
      !current.checksums.sha256 ||
      Buffer.from(current.checksums.sha256).toString("hex") !== file.sha256
    )
      throw new HttpError(409, "Stored file integrity mismatch");
  }
  try {
    await getUpload(env, id);
  } catch (error) {
    // Close the write/delete race; the scheduled tombstone sweep covers crashes.
    if (error instanceof HttpError && error.status === 410)
      await env.PRIVATE_ARTIFACTS.delete(key);
    throw error;
  }
  return new Response(null, { status: 204 });
}

async function commitUpload(
  env: Env,
  id: string,
  origin: string,
): Promise<Response> {
  const upload = await getUpload(env, id);
  const manifest: UploadRequest = JSON.parse(upload.manifest);
  const existing = await env.DB.prepare(
    "SELECT number FROM library_versions WHERE id = ?",
  )
    .bind(id)
    .first<{ number: number }>();
  if (!existing) {
    for (const file of manifest.files) {
      const object = await env.PRIVATE_ARTIFACTS.get(
        objectKey(upload, file.path),
      );
      if (!object || object.size !== file.size) {
        await object?.body.cancel();
        throw new HttpError(409, "Upload is incomplete or corrupt");
      }
      if (sha256(new Uint8Array(await object.arrayBuffer())) !== file.sha256)
        throw new HttpError(409, "Upload is incomplete or corrupt");
    }
    // The allocation and insertion are one SQL statement. Concurrent commits
    // either create one version or observe it, never allocate duplicate numbers.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO library_versions (id, artifact_id, number, created_at)
        SELECT ?, a.id, COALESCE((SELECT MAX(number) FROM library_versions WHERE artifact_id = a.id), 0) + 1, ?
        FROM library_artifacts a WHERE a.id = ? AND a.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM library_versions WHERE id = ?)
        ON CONFLICT(id) DO NOTHING`,
      ).bind(id, new Date().toISOString(), upload.artifact_id, id),
      env.DB.prepare(
        `UPDATE library_projects SET name = ? WHERE id = ? AND EXISTS (
        SELECT 1 FROM library_versions v JOIN library_artifacts a ON a.id = v.artifact_id
        WHERE v.id = ? AND a.deleted_at IS NULL AND v.number = (SELECT MAX(number) FROM library_versions WHERE artifact_id = a.id))`,
      ).bind(manifest.project.name, manifest.project.id, id),
    ]);
  }
  const version = await getVersion(env, id);
  const result: UploadResult = {
    artifactId: upload.artifact_id,
    version: version.number,
    dashboardUrl: dashboard(origin, upload.artifact_id),
  };
  return Response.json(result);
}

async function getVersion(env: Env, id: string): Promise<VersionRow> {
  const row = await env.DB.prepare(
    `SELECT v.*, u.manifest, a.deleted_at FROM library_versions v
    JOIN library_uploads u ON u.id = v.id JOIN library_artifacts a ON a.id = v.artifact_id
    WHERE v.id = ? AND a.deleted_at IS NULL`,
  )
    .bind(id)
    .first<VersionRow>();
  if (!row) throw new HttpError(404, "Not found");
  return row;
}

function dashboard(origin: string, id: string): string {
  return `${origin}/inventory/artifacts/${id}`;
}

function versionInfo(row: VersionRow, previewUrl: string): ArtifactVersion {
  const manifest: UploadRequest = JSON.parse(row.manifest);
  return {
    id: row.id,
    number: row.number,
    createdAt: row.created_at,
    entryPath: manifest.entryPath,
    fileCount: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    previewUrl,
  };
}

function shareInfo(row: ShareRow, origin: string): ArtifactShare {
  return {
    url: `${origin}/s/${row.token}`,
    versionId: row.version_id,
    expiresAt: row.expires_at,
    status:
      row.expires_at !== null && !(Date.parse(row.expires_at) > Date.now())
        ? "expired"
        : "active",
  };
}

async function library(
  env: Env,
  origin: string,
  id?: string,
): Promise<ArtifactLibrary> {
  // Version number, not request start time, is the authoritative commit order.
  const rows = await env.DB.prepare(
    `SELECT v.*, u.manifest, a.project_id, p.name AS project_name, a.deleted_at,
    s.token, s.version_id, s.expires_at FROM library_versions v
    JOIN library_uploads u ON u.id = v.id JOIN library_artifacts a ON a.id = v.artifact_id
    JOIN library_projects p ON p.id = a.project_id LEFT JOIN library_shares s ON s.artifact_id = a.id
    WHERE a.deleted_at IS NULL AND (? IS NULL OR a.id = ?) ORDER BY v.number DESC`,
  )
    .bind(id ?? null, id ?? null)
    .all<
      VersionRow & ShareRow & { project_id: string; project_name: string }
    >();
  const artifacts = new Map<string, LibraryArtifact>();
  const projects = new Map<string, { id: string; name: string }>();
  for (const row of rows.results) {
    const manifest: UploadRequest = JSON.parse(row.manifest);
    let artifact = artifacts.get(row.artifact_id);
    if (!artifact) {
      artifact = {
        id: row.artifact_id,
        projectId: row.project_id,
        title: manifest.title,
        updatedAt: row.created_at,
        versions: [],
        share: row.token ? shareInfo(row, origin) : null,
      };
      artifacts.set(artifact.id, artifact);
    }
    artifact.versions.push(
      versionInfo(
        row,
        `${origin}/api/previews/${previewToken(row.id, env)}/files/${encodePath(manifest.entryPath)}`,
      ),
    );
    projects.set(row.project_id, {
      id: row.project_id,
      name: row.project_name,
    });
  }
  return {
    projects: [...projects.values()],
    artifacts: [...artifacts.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
  };
}

async function shareArtifact(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const parsed = shareRequestSchema.safeParse(await readJson(request, 4096));
  if (!parsed.success) throw new HttpError(400, "Invalid share request");
  const { versionId, expiresInDays } = parsed.data;
  const expires =
    expiresInDays === null
      ? null
      : new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");
  const row = await env.DB.prepare(
    `INSERT INTO library_shares (artifact_id, token, version_id, expires_at)
    SELECT a.id, ?, v.id, ? FROM library_artifacts a JOIN library_versions v ON v.artifact_id = a.id
    WHERE a.id = ? AND v.id = ? AND a.deleted_at IS NULL
    ON CONFLICT(artifact_id) DO UPDATE SET version_id = excluded.version_id, expires_at = excluded.expires_at,
      token = CASE WHEN library_shares.expires_at IS NULL OR julianday(library_shares.expires_at) > julianday(?)
        THEN library_shares.token ELSE excluded.token END
    RETURNING token, version_id, expires_at`,
  )
    .bind(token, expires, id, versionId, new Date().toISOString())
    .first<ShareRow>();
  if (!row) throw new HttpError(404, "Not found");
  return Response.json(shareInfo(row, new URL(request.url).origin));
}

async function publicVersion(
  env: Env,
  token: string,
): Promise<VersionRow & { expires_at: string | null }> {
  const row = await env.DB.prepare(
    `SELECT v.*, u.manifest, a.deleted_at, s.expires_at FROM library_shares s
    JOIN library_versions v ON v.id = s.version_id AND v.artifact_id = s.artifact_id
    JOIN library_uploads u ON u.id = v.id JOIN library_artifacts a ON a.id = v.artifact_id
    WHERE s.token = ? AND a.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)`,
  )
    .bind(token, new Date().toISOString())
    .first<VersionRow & { expires_at: string | null }>();
  if (
    !row ||
    (row.expires_at !== null && !(Date.parse(row.expires_at) > Date.now()))
  )
    throw new HttpError(404, "Not found");
  return row;
}

async function serveFile(
  env: Env,
  version: VersionRow,
  path: string,
  root: string,
  head: boolean,
): Promise<Response> {
  const manifest: UploadRequest = JSON.parse(version.manifest);
  const file = manifest.files.find((item) => item.path === path);
  if (!file) throw new HttpError(404, "Not found");
  const object = await env.PRIVATE_ARTIFACTS.get(objectKey(version, path));
  if (
    !object ||
    object.size !== file.size ||
    !object.checksums.sha256 ||
    Buffer.from(object.checksums.sha256).toString("hex") !== file.sha256
  ) {
    await object?.body.cancel();
    throw new HttpError(404, "Not found");
  }
  const headers = fileHeaders(path, root);
  headers.set("Content-Length", String(file.size));
  if (head) await object.body.cancel();
  return new Response(head ? null : object.body, { headers });
}

async function purgeObjects(env: Env, id: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.PRIVATE_ARTIFACTS.list({
      prefix: `library/${id}/`,
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.length)
      await env.PRIVATE_ARTIFACTS.delete(
        page.objects.map((object) => object.key),
      );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Keep only denial receipts for retries, not deleted version manifests/titles.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM library_versions WHERE artifact_id = ? AND EXISTS (SELECT 1 FROM library_artifacts WHERE id = ? AND deleted_at IS NOT NULL)",
    ).bind(id, id),
    env.DB.prepare(
      "UPDATE library_uploads SET manifest = '{}' WHERE artifact_id = ? AND EXISTS (SELECT 1 FROM library_artifacts WHERE id = ? AND deleted_at IS NOT NULL)",
    ).bind(id, id),
  ]);
}
