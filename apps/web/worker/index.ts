import {
  MAX_ARTIFACT_REVISIONS,
  MAX_ARTIFACT_SOURCE_BYTES,
  MAX_ARTIFACT_TOTAL_SOURCE_BYTES,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  artifactIdSchema,
  artifactResponseSchema,
  createArtifactRequestSchema,
  createArtifactResponseSchema,
  createRevisionRequestSchema,
  ownerTokenSchema,
  revisionIdSchema,
  revisionResponseSchema,
  shareResponseSchema,
  type ApiErrorCode,
  type Artifact,
  type ErrorIssue,
  type Revision,
} from "@opencode-panes/contracts";

// JSON can encode one UTF-8 source byte as a six-byte Unicode escape.
export const MAX_JSON_BODY_BYTES = MAX_ARTIFACT_SOURCE_BYTES * 6 + 16 * 1024;
const CREATE_KEY_HEADER = "X-Panes-Create-Key";
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

interface ArtifactRow {
  id: string;
  owner_token_hash: string;
  workspace_token_hash: string;
  title: string;
  type: Artifact["type"];
  current_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  artifact_id: string;
  version: number;
  source: string;
  created_at: string;
}

interface ActiveShareRow {
  token_hash: string;
  revision_id: string;
}

interface PublicShareRow extends RevisionRow {
  title: string;
  type: Artifact["type"];
  published_at: string;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

interface Parser<T> {
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
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: Response };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const crossOriginError = rejectCrossOriginRequest(request);
    if (crossOriginError) return crossOriginError;

    if (request.method === "OPTIONS") return preflightResponse(request);

    try {
      const response = await routeRequest(request, env);
      return withCorsHeaders(request, response);
    } catch (error) {
      logUnexpectedError(request, error);
      return withCorsHeaders(
        request,
        errorResponse(500, "INTERNAL_ERROR", "An internal error occurred"),
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/artifacts") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const admissionError = await requireCreateAdmission(
      request,
      env.PANES_CREATE_API_KEY,
    );
    if (admissionError) return admissionError;
    return createArtifact(request, env.DB);
  }

  const publicMatch = pathname.match(/^\/api\/public\/([^/]+)$/);
  if (publicMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const token = decodePathSegment(publicMatch[1]);
    if (!token || !ownerTokenSchema.safeParse(token).success) {
      return errorResponse(404, "NOT_FOUND", "Share not found");
    }
    return getPublicShare(token, env.DB);
  }

  const revisionsMatch = pathname.match(
    /^\/api\/artifacts\/([^/]+)\/revisions$/,
  );
  if (revisionsMatch) {
    const artifactId = parseArtifactId(revisionsMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    if (request.method === "POST")
      return createRevision(request, env.DB, artifactId);
    if (request.method === "GET")
      return listRevisions(request, env.DB, artifactId);
    return methodNotAllowed(["GET", "POST"]);
  }

  const publishMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/publish$/);
  if (publishMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(publishMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    return publishRevision(request, env.DB, artifactId);
  }

  const unpublishMatch = pathname.match(
    /^\/api\/artifacts\/([^/]+)\/unpublish$/,
  );
  if (unpublishMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(unpublishMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    return unpublishArtifact(request, env.DB, artifactId);
  }

  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch) {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const artifactId = parseArtifactId(artifactMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    return getArtifact(request, env.DB, artifactId);
  }

  return errorResponse(404, "NOT_FOUND", "Route not found");
}

async function createArtifact(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const body = await parseJsonBody(request, createArtifactRequestSchema);
  if (!body.ok) return body.response;

  const artifactId = `artifact_${crypto.randomUUID()}`;
  const revisionId = `revision_${crypto.randomUUID()}`;
  const ownerToken = randomToken();
  const workspaceToken = randomToken();
  const [ownerTokenHash, workspaceTokenHash] = await Promise.all([
    hashToken(ownerToken),
    hashToken(workspaceToken),
  ]);
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT INTO artifacts
          (id, owner_token_hash, workspace_token_hash, opencode_session_id, title, type, current_revision_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        artifactId,
        ownerTokenHash,
        workspaceTokenHash,
        body.data.sessionId,
        body.data.title,
        body.data.type,
        revisionId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO revisions (id, artifact_id, version, source, created_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .bind(revisionId, artifactId, body.data.source, now),
  ]);

  const artifact: Artifact = {
    id: artifactId,
    title: body.data.title,
    type: body.data.type,
    currentRevisionId: revisionId,
    createdAt: now,
    updatedAt: now,
  };
  const revision: Revision = {
    id: revisionId,
    artifactId,
    version: 1,
    source: body.data.source,
    createdAt: now,
  };

  return jsonResponse(
    createArtifactResponseSchema.parse({
      artifact,
      revision,
      ownerToken,
      viewerUrl: viewerUrl(request, artifactId, workspaceToken),
    }),
    201,
  );
}

async function createRevision(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response> {
  const artifact = await authenticateOwner(request, db, artifactId);
  if (artifact instanceof Response) return artifact;

  const body = await parseJsonBody(request, createRevisionRequestSchema);
  if (!body.ok) return body.response;

  const revisionId = `revision_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const sourceBytes = utf8ByteLength(body.data.source);

  const [insertResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO revisions (id, artifact_id, version, source, created_at)
         SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?
         FROM revisions
         WHERE artifact_id = ?
         HAVING COUNT(*) < ?
            AND COALESCE(SUM(length(CAST(source AS BLOB))), 0) + ? <= ?`,
      )
      .bind(
        revisionId,
        artifactId,
        body.data.source,
        now,
        artifactId,
        MAX_ARTIFACT_REVISIONS,
        sourceBytes,
        MAX_ARTIFACT_TOTAL_SOURCE_BYTES,
      ),
    db
      .prepare(
        `UPDATE artifacts
         SET current_revision_id = ?, updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM revisions WHERE id = ? AND artifact_id = ?
           )`,
      )
      .bind(revisionId, now, artifactId, revisionId, artifactId),
  ]);

  if (!insertResult)
    throw new Error("Revision batch returned no insert result");
  if (insertResult.meta.changes === 0) {
    return errorResponse(
      409,
      "CONFLICT",
      "Artifact revision storage limit reached",
    );
  }

  const row = await db
    .prepare(
      `SELECT id, artifact_id, version, source, created_at
       FROM revisions
       WHERE id = ? AND artifact_id = ?`,
    )
    .bind(revisionId, artifactId)
    .first<RevisionRow>();

  if (!row) throw new Error("Created revision was not found");

  return jsonResponse(
    revisionResponseSchema.parse({
      artifactId,
      revision: toRevision(row),
      viewerUrl: viewerUrl(request, artifactId),
    }),
    201,
  );
}

async function getArtifact(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response> {
  const artifact = await authenticateArtifact(request, db, artifactId, false);
  if (artifact instanceof Response) return artifact;

  const revision = await db
    .prepare(
      `SELECT id, artifact_id, version, source, created_at
       FROM revisions
       WHERE id = ? AND artifact_id = ?`,
    )
    .bind(artifact.current_revision_id, artifactId)
    .first<RevisionRow>();

  if (!revision) throw new Error("Current revision was not found");

  return jsonResponse(
    artifactResponseSchema.parse({
      artifact: toArtifact(artifact),
      revision: toRevision(revision),
      viewerUrl: viewerUrl(request, artifactId),
    }),
  );
}

async function listRevisions(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response> {
  const artifact = await authenticateArtifact(request, db, artifactId, false);
  if (artifact instanceof Response) return artifact;

  const result = await db
    .prepare(
      `SELECT id, artifact_id, version, source, created_at
       FROM revisions
       WHERE artifact_id = ?
       ORDER BY version DESC`,
    )
    .bind(artifactId)
    .all<RevisionRow>();

  // The 2 MiB aggregate cap bounds this source-bearing response to about 12 MiB
  // even when every source byte needs JSON escaping, so a lazy source route is
  // unnecessary for the MVP and the existing client contract remains intact.
  return jsonResponse({
    artifactId,
    revisions: result.results.map(toRevision),
  });
}

async function publishRevision(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response> {
  const artifact = await authenticateArtifact(request, db, artifactId, false);
  if (artifact instanceof Response) return artifact;

  const body = await parsePublishBody(request);
  if (!body.ok) return body.response;

  const revision = await db
    .prepare(
      `SELECT id, artifact_id, version, source, created_at
       FROM revisions
       WHERE id = ? AND artifact_id = ?`,
    )
    .bind(body.data.revisionId, artifactId)
    .first<RevisionRow>();

  if (!revision) {
    return errorResponse(404, "NOT_FOUND", "Revision not found");
  }

  const activeShare = await db
    .prepare(
      `SELECT token_hash, revision_id
       FROM shares
       WHERE artifact_id = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(artifactId)
    .first<ActiveShareRow>();

  // Only hashes are persisted, so an unchanged active share has no token to return again.
  if (activeShare?.revision_id === revision.id)
    return new Response(null, { status: 204 });

  const shareToken = randomToken();
  const tokenHash = await hashToken(shareToken);
  const now = new Date().toISOString();

  const [, insertResult] = await db.batch([
    db
      .prepare(
        `UPDATE shares
         SET revoked_at = ?
         WHERE token_hash = ? AND artifact_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, activeShare?.token_hash ?? "", artifactId),
    db
      .prepare(
        `INSERT INTO shares (token_hash, artifact_id, revision_id, created_at, revoked_at)
         SELECT ?, ?, ?, ?, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM shares WHERE artifact_id = ? AND revoked_at IS NULL
         )`,
      )
      .bind(tokenHash, artifactId, revision.id, now, artifactId),
  ]);

  if (!insertResult) throw new Error("Publish batch returned no insert result");
  if (insertResult.meta.changes === 0) {
    const winner = await db
      .prepare(
        `SELECT token_hash, revision_id
         FROM shares
         WHERE artifact_id = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(artifactId)
      .first<ActiveShareRow>();

    if (winner?.revision_id === revision.id) {
      return new Response(null, { status: 204 });
    }

    return errorResponse(
      409,
      "CONFLICT",
      "Artifact publication changed; retry the request",
    );
  }

  return jsonResponse(
    shareResponseSchema.parse({
      artifactId,
      revisionId: revision.id,
      version: revision.version,
      publicUrl: publicUrl(request, shareToken),
      createdAt: now,
    }),
    201,
  );
}

async function unpublishArtifact(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<Response> {
  const artifact = await authenticateArtifact(request, db, artifactId, false);
  if (artifact instanceof Response) return artifact;

  await db
    .prepare(
      `UPDATE shares
       SET revoked_at = ?
       WHERE artifact_id = ? AND revoked_at IS NULL`,
    )
    .bind(new Date().toISOString(), artifactId)
    .run();

  return new Response(null, { status: 204 });
}

async function getPublicShare(
  token: string,
  db: D1Database,
): Promise<Response> {
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT
         a.title,
         a.type,
         r.id,
         r.artifact_id,
         r.version,
         r.source,
         r.created_at,
         s.created_at AS published_at
       FROM shares s
       JOIN artifacts a ON a.id = s.artifact_id
       JOIN revisions r ON r.id = s.revision_id AND r.artifact_id = s.artifact_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<PublicShareRow>();

  if (!row) return errorResponse(404, "NOT_FOUND", "Share not found");

  return jsonResponse({
    artifact: {
      id: row.artifact_id,
      title: row.title,
      type: row.type,
    },
    revision: toRevision(row),
    publishedAt: row.published_at,
  });
}

async function authenticateOwner(
  request: Request,
  db: D1Database,
  artifactId: string,
): Promise<ArtifactRow | Response> {
  return authenticateArtifact(request, db, artifactId, true);
}

async function authenticateArtifact(
  request: Request,
  db: D1Database,
  artifactId: string,
  ownerOnly: boolean,
): Promise<ArtifactRow | Response> {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  const token = match?.[1];
  if (!token || !ownerTokenSchema.safeParse(token).success) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      ownerOnly
        ? "A bearer owner token is required"
        : "A bearer owner or workspace token is required",
      undefined,
      {
        "WWW-Authenticate": "Bearer",
      },
    );
  }

  const artifact = await db
    .prepare(
      `SELECT id, owner_token_hash, workspace_token_hash, title, type, current_revision_id, created_at, updated_at
       FROM artifacts
       WHERE id = ?`,
    )
    .bind(artifactId)
    .first<ArtifactRow>();

  if (!artifact) return errorResponse(404, "NOT_FOUND", "Artifact not found");

  const providedHash = await hashToken(token);
  const isOwner = constantTimeHashEqual(
    providedHash,
    artifact.owner_token_hash,
  );
  const isWorkspace = constantTimeHashEqual(
    providedHash,
    artifact.workspace_token_hash,
  );
  if (!isOwner && (ownerOnly || !isWorkspace)) {
    return errorResponse(
      403,
      "FORBIDDEN",
      ownerOnly
        ? "The owner token is invalid"
        : "The owner or workspace token is invalid",
    );
  }

  return artifact;
}

async function parseJsonBody<T>(
  request: Request,
  parser: Parser<T>,
): Promise<ParsedBody<T>> {
  const parsedJson = await readJson(request);
  if (!parsedJson.ok) return parsedJson;

  const result = parser.safeParse(parsedJson.data);
  if (result.success) return { ok: true, data: result.data };

  const issues = result.error.issues.map(toErrorIssue);
  const sourceTooLarge = result.error.issues.some(
    (issue) =>
      issue.path[0] === "source" && issue.message.includes("UTF-8 bytes"),
  );
  return {
    ok: false,
    response: errorResponse(
      sourceTooLarge ? 413 : 400,
      sourceTooLarge ? "SOURCE_TOO_LARGE" : "VALIDATION_ERROR",
      sourceTooLarge
        ? "Artifact source is too large"
        : "Request validation failed",
      issues,
    ),
  };
}

async function parsePublishBody(
  request: Request,
): Promise<ParsedBody<{ revisionId: string }>> {
  const parsedJson = await readJson(request);
  if (!parsedJson.ok) return parsedJson;

  if (
    typeof parsedJson.data !== "object" ||
    parsedJson.data === null ||
    Array.isArray(parsedJson.data)
  ) {
    return validationResponse([{ path: [], message: "Expected an object" }]);
  }

  const record = parsedJson.data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "revisionId") {
    return validationResponse([
      { path: [], message: "Expected only the revisionId property" },
    ]);
  }

  const revisionId = revisionIdSchema.safeParse(record.revisionId);
  if (!revisionId.success) {
    return validationResponse(revisionId.error.issues.map(toErrorIssue));
  }

  return { ok: true, data: { revisionId: revisionId.data } };
}

async function readJson(request: Request): Promise<ParsedBody<unknown>> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return validationResponse([
      { path: [], message: "Content-Type must be application/json" },
    ]);
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    return sourceTooLargeResponse();
  }

  const bytes = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  if (!bytes) return sourceTooLargeResponse();

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return validationResponse([
      { path: [], message: "Body must be valid UTF-8 JSON" },
    ]);
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("Request body exceeds the JSON limit");
      return undefined;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function requireCreateAdmission(
  request: Request,
  expectedKey: string | undefined,
): Promise<Response | undefined> {
  if (expectedKey === undefined) return undefined;

  const providedKey = request.headers.get(CREATE_KEY_HEADER) ?? "";
  if (await timingSafeSecretEqual(providedKey, expectedKey)) return undefined;

  return errorResponse(
    401,
    "UNAUTHORIZED",
    "Artifact creation requires a valid admission key",
  );
}

function parseArtifactId(segment: string | undefined): string | Response {
  const value = decodePathSegment(segment);
  const parsed = artifactIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return errorResponse(400, "VALIDATION_ERROR", "Artifact ID is invalid", [
    { path: ["artifactId"], message: "Artifact ID is invalid" },
  ]);
}

function decodePathSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return bytesToHex(new Uint8Array(digest));
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (!leftBytes || !rightBytes) return false;
  return (crypto.subtle as TimingSafeSubtleCrypto).timingSafeEqual(
    leftBytes,
    rightBytes,
  );
}

async function timingSafeSecretEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return (crypto.subtle as TimingSafeSubtleCrypto).timingSafeEqual(
    leftHash,
    rightHash,
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/.test(value)) return undefined;
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    currentRevisionId: row.current_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRevision(row: RevisionRow): Revision {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    source: row.source,
    createdAt: row.created_at,
  };
}

function viewerUrl(
  request: Request,
  artifactId: string,
  workspaceToken?: string,
): string {
  const url = new URL(
    `/artifacts/${encodeURIComponent(artifactId)}`,
    request.url,
  );
  if (workspaceToken) {
    url.hash = new URLSearchParams({
      [WORKSPACE_TOKEN_FRAGMENT_KEY]: workspaceToken,
    }).toString();
  }
  return url.toString();
}

function publicUrl(request: Request, shareToken: string): string {
  return new URL(
    `/shared/${encodeURIComponent(shareToken)}`,
    request.url,
  ).toString();
}

function rejectCrossOriginRequest(request: Request): Response | undefined {
  const origin = request.headers.get("Origin");
  if (!origin || origin === new URL(request.url).origin) return undefined;
  return errorResponse(
    403,
    "FORBIDDEN",
    "Cross-origin requests are not allowed",
  );
}

function preflightResponse(request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return methodNotAllowed(["GET", "POST"]);

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": `Authorization, Content-Type, ${CREATE_KEY_HEADER}`,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

export function logUnexpectedError(request: Request, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "worker.request.unexpected_error",
      errorName: error instanceof Error ? error.name : "UnknownError",
      method: request.method,
      route: routeTemplate(new URL(request.url).pathname),
    }),
  );
}

function routeTemplate(pathname: string): string {
  if (pathname === "/api/artifacts") return "/api/artifacts";
  if (/^\/api\/public\/[^/]+$/.test(pathname)) return "/api/public/:token";
  if (/^\/api\/artifacts\/[^/]+\/revisions$/.test(pathname)) {
    return "/api/artifacts/:artifactId/revisions";
  }
  if (/^\/api\/artifacts\/[^/]+\/publish$/.test(pathname)) {
    return "/api/artifacts/:artifactId/publish";
  }
  if (/^\/api\/artifacts\/[^/]+\/unpublish$/.test(pathname)) {
    return "/api/artifacts/:artifactId/unpublish";
  }
  if (/^\/api\/artifacts\/[^/]+$/.test(pathname)) {
    return "/api/artifacts/:artifactId";
  }
  return "unmatched";
}

function withCorsHeaders(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function methodNotAllowed(methods: string[]): Response {
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

function sourceTooLargeResponse(): ParsedBody<never> {
  return {
    ok: false,
    response: errorResponse(
      413,
      "SOURCE_TOO_LARGE",
      "Artifact source is too large",
    ),
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

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  issues?: ErrorIssue[],
  extraHeaders?: HeadersInit,
): Response {
  const error = issues ? { code, message, issues } : { code, message };
  return jsonResponse({ error }, status, extraHeaders);
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((headerValue, name) =>
      headers.set(name, headerValue),
    );
  }
  return new Response(JSON.stringify(value), { status, headers });
}
