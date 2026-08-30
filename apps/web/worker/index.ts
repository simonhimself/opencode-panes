import {
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  artifactIdSchema,
  artifactResponseSchema,
  ownerTokenSchema,
  type ApiErrorCode,
  type Artifact,
  type ErrorIssue,
  type Revision,
} from "@opencode-panes/contracts";
import { cleanupTemporarySyncUploads, routeSyncRequest } from "./sync";
import { verifyAccessRequest } from "./access";
import {
  deleteInventoryArtifact,
  deleteLegacyInventoryArtifact,
} from "./deletion";
import {
  inventoryResponse,
  loadInventory,
  mutateInventoryPublicationRequest,
  issueInventoryReconnectCode,
  rotateInventoryCreator,
} from "./inventory";
import { getLegacyArtifact } from "./legacy";
import { issueLegacyAdoptionCode, redeemLegacyAdoption } from "./adoption";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
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

interface PublicShareRow extends RevisionRow {
  title: string;
  type: Artifact["type"];
  published_at: string;
  public_expires_at: string | null;
  revoked_at: string | null;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const crossOriginError = rejectCrossOriginRequest(request);
    if (crossOriginError) return crossOriginError;

    if (request.method === "OPTIONS")
      return withCorsHeaders(request, preflightResponse(request));

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
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await cleanupTemporarySyncUploads(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname.startsWith("/api/inventory")) {
    const access = await verifyAccessRequest(request, env);
    if (!access.ok) {
      return errorResponse(
        access.status,
        access.status === 503 ? "SERVICE_UNAVAILABLE" : "UNAUTHORIZED",
        access.status === 503
          ? "Inventory authentication is unavailable"
          : "Inventory authentication is required",
      );
    }
  }

  const syncResponse = await routeSyncRequest(request, env);
  if (syncResponse) return syncResponse;

  if (pathname === "/api/inventory") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return inventoryResponse(await loadInventory(request, env));
  }

  const adoptionIssue = pathname.match(
    /^\/api\/inventory\/legacy\/artifacts\/([^/]+)\/adoption-code$/u,
  );
  if (adoptionIssue) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(adoptionIssue[1]);
    if (artifactId instanceof Response) return artifactId;
    return issueLegacyAdoptionCode(env, artifactId);
  }

  const adoptionRedeem = pathname.match(/^\/api\/adopt\/legacy\/([^/]+)$/u);
  if (adoptionRedeem) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(adoptionRedeem[1]);
    if (artifactId instanceof Response) return artifactId;
    return redeemLegacyAdoption(request, env, artifactId);
  }

  const inventoryCreatorRotation = pathname.match(
    /^\/api\/inventory\/artifacts\/([^/]+)\/creator\/rotate$/u,
  );
  if (inventoryCreatorRotation) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(inventoryCreatorRotation[1]);
    if (artifactId instanceof Response) return artifactId;
    return rotateInventoryCreator(request, env, artifactId);
  }

  const inventoryReconnect = pathname.match(
    /^\/api\/inventory\/artifacts\/([^/]+)\/reconnect-code$/u,
  );
  if (inventoryReconnect) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(inventoryReconnect[1]);
    if (artifactId instanceof Response) return artifactId;
    return issueInventoryReconnectCode(request, env, artifactId);
  }

  const inventoryPublication = pathname.match(
    /^\/api\/inventory\/artifacts\/([^/]+)\/publication\/(extend|unpublish|republish)$/u,
  );
  if (inventoryPublication) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const artifactId = parseArtifactId(inventoryPublication[1]);
    if (artifactId instanceof Response) return artifactId;
    return mutateInventoryPublicationRequest(
      request,
      env,
      artifactId,
      inventoryPublication[2] as "extend" | "unpublish" | "republish",
    );
  }

  const inventoryDeletion = pathname.match(
    /^\/api\/inventory\/artifacts\/([^/]+)$/u,
  );
  if (inventoryDeletion) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const artifactId = parseArtifactId(inventoryDeletion[1]);
    if (artifactId instanceof Response) return artifactId;
    return deleteInventoryArtifact(request, env, artifactId);
  }

  const legacyInventoryDeletion = pathname.match(
    /^\/api\/inventory\/legacy\/artifacts\/([^/]+)$/u,
  );
  if (legacyInventoryDeletion) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const artifactId = parseArtifactId(legacyInventoryDeletion[1]);
    if (artifactId instanceof Response) return artifactId;
    return deleteLegacyInventoryArtifact(request, env, artifactId);
  }

  if (pathname === "/api/artifacts") {
    if (request.method === "POST") return legacyMutationResponse();
    return methodNotAllowed(["POST"]);
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
    if (request.method === "POST") return legacyMutationResponse();
    const artifactId = parseArtifactId(revisionsMatch[1]);
    if (artifactId instanceof Response) return artifactId;
    if (request.method === "GET")
      return listRevisions(request, env.DB, artifactId);
    return methodNotAllowed(["GET", "POST"]);
  }

  const publishMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/publish$/);
  if (publishMatch) {
    if (request.method === "POST") return legacyMutationResponse();
    return methodNotAllowed(["POST"]);
  }

  const unpublishMatch = pathname.match(
    /^\/api\/artifacts\/([^/]+)\/unpublish$/,
  );
  if (unpublishMatch) {
    if (request.method === "POST") return legacyMutationResponse();
    return methodNotAllowed(["POST"]);
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
  const legacy = await getLegacyArtifact(db, artifactId);

  return jsonResponse(
    artifactResponseSchema.parse({
      artifact: toArtifact(artifact),
      revision: toRevision(revision),
      viewerUrl: viewerUrl(request, artifactId),
      ...(legacy
        ? {
            legacy: {
              readOnly: true,
              migratedAt: legacy.migrated_at,
              privateExpiresAt: legacy.private_expires_at,
            },
          }
        : {}),
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

  // Legacy source-bearing responses remain bounded by the retained adoption cap.
  // even when every source byte needs JSON escaping, so a lazy source route is
  // unnecessary for the MVP and the existing client contract remains intact.
  return jsonResponse({
    artifactId,
    revisions: result.results.map(toRevision),
  });
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
          s.created_at AS published_at,
          ls.public_expires_at,
          s.revoked_at
        FROM shares s
        JOIN artifacts a ON a.id = s.artifact_id
        JOIN revisions r ON r.id = s.revision_id AND r.artifact_id = s.artifact_id
        LEFT JOIN legacy_shares ls ON ls.token_hash = s.token_hash
        WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<PublicShareRow>();

  if (!row) return errorResponse(404, "NOT_FOUND", "Share not found");
  if (row.revoked_at !== null)
    return legacyGoneResponse("This legacy share has been revoked");
  if (
    row.public_expires_at !== null &&
    row.public_expires_at <= new Date().toISOString()
  )
    return legacyGoneResponse("This legacy share has expired");

  return jsonResponse({
    artifact: {
      id: row.artifact_id,
      title: row.title,
      type: row.type,
    },
    revision: toRevision(row),
    publishedAt: row.published_at,
    ...(row.public_expires_at !== null ? { legacy: { readOnly: true } } : {}),
  });
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

  const legacyArtifact = await getLegacyArtifact(db, artifactId);
  if (
    legacyArtifact &&
    legacyArtifact.private_expires_at <= new Date().toISOString()
  ) {
    return legacyGoneResponse("This legacy artifact has expired");
  }

  return artifact;
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
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "DELETE, GET, POST, OPTIONS",
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
  if (pathname === "/api/sync/artifacts") return "/api/sync/artifacts";
  if (/^\/api\/creator\/[^/]+$/.test(pathname)) return "/api/creator/:token";
  if (/^\/api\/sync\/artifacts\/[^/]+\/creator\/rotate$/u.test(pathname)) {
    return "/api/sync/artifacts/:artifactId/creator/rotate";
  }
  if (/^\/api\/sync\/artifacts\/[^/]+\/lease\/release$/u.test(pathname)) {
    return "/api/sync/artifacts/:artifactId/lease/release";
  }
  if (
    /^\/api\/sync\/artifacts\/[^/]+\/revisions\/\d+\/files\/.+$/u.test(pathname)
  ) {
    return "/api/sync/artifacts/:artifactId/revisions/:version/files/:path";
  }
  if (/^\/api\/publications\/[^/]+\/files\/.+$/u.test(pathname)) {
    return "/api/publications/:token/files/:path";
  }
  if (/^\/api\/creator\/[^/]+\/revisions\/\d+\/files\/.+$/u.test(pathname)) {
    return "/api/creator/:token/revisions/:version/files/:path";
  }
  if (
    /^\/api\/creator\/[^/]+\/revisions\/\d+\/download\.zip$/u.test(pathname)
  ) {
    return "/api/creator/:token/revisions/:version/download.zip";
  }
  if (/^\/api\/publications\/[^/]+\/download\.zip$/u.test(pathname)) {
    return "/api/publications/:token/download.zip";
  }
  if (
    /^\/api\/sync\/artifacts\/[^/]+\/revisions\/\d+\/commit$/u.test(pathname)
  ) {
    return "/api/sync/artifacts/:artifactId/revisions/:version/commit";
  }
  if (/^\/api\/public\/[^/]+$/.test(pathname)) return "/api/public/:token";
  if (/^\/api\/publications\/[^/]+$/.test(pathname)) {
    return "/api/publications/:token";
  }
  if (
    /^\/api\/creator\/[^/]+\/(?:publication\/)?(?:share|publish|republish|extend|unpublish)$/u.test(
      pathname,
    )
  ) {
    return "/api/creator/:token/publication-action";
  }
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
  if (/^\/api\/inventory\/artifacts\/[^/]+\/reconnect-code$/u.test(pathname)) {
    return "/api/inventory/artifacts/:artifactId/reconnect-code";
  }
  if (/^\/api\/inventory\/legacy\/artifacts\/[^/]+$/u.test(pathname)) {
    return "/api/inventory/legacy/artifacts/:artifactId";
  }
  if (
    /^\/api\/inventory\/legacy\/artifacts\/[^/]+\/adoption-code$/u.test(
      pathname,
    )
  ) {
    return "/api/inventory/legacy/artifacts/:artifactId/adoption-code";
  }
  if (/^\/api\/adopt\/legacy\/[^/]+$/u.test(pathname)) {
    return "/api/adopt/legacy/:artifactId";
  }
  if (pathname === "/api/inventory") return "/api/inventory";
  return "unmatched";
}

function withCorsHeaders(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
  }
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

const LEGACY_MUTATION_MESSAGE =
  "Legacy mutation is no longer supported. Create or adopt a project-local Artifact and Sync it.";

function legacyMutationResponse(): Response {
  return errorResponse(
    410,
    "LOCAL_FIRST_REQUIRED",
    LEGACY_MUTATION_MESSAGE,
    undefined,
    {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  );
}

function legacyGoneResponse(message: string): Response {
  return errorResponse(410, "GONE", message, undefined, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
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
