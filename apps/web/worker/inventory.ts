import {
  RECONNECT_CODE_PREFIX,
  RECONNECT_CODE_TTL_MS,
  inventoryReconnectCodeRequestSchema,
  inventoryReconnectCodeResponseSchema,
  inventoryCreatorRotateResponseSchema,
  inventoryPublicationMutationRequestSchema,
  inventoryPublicationUnpublishRequestSchema,
  inventoryResponseSchema,
  syncCreatorRotateRequestSchema,
  type InventoryResponse,
} from "@opencode-panes/contracts";
import { decryptPublicationToken } from "./publication";
import {
  rotateCreatorLinkForInventory,
  type InventoryCreatorRotation,
} from "./sync";
import { mutatePublicationForInventory } from "./publication";
import { readBoundedText } from "./bounded-json";

const INVENTORY_BODY_LIMIT = 4096;
const RECONNECT_CODE_ID_PREFIX = "owner-reconnect-";

interface InventoryRow {
  project_id: string;
  artifact_id: string;
  slug: string;
  title: string;
  kind: string | null;
  lifecycle_state: "active" | "deleting";
  revision_count: number;
  storage_bytes: number;
  last_synced_at: string | null;
  creator_status: "active" | "expired" | "revoked";
  creator_expires_at: string;
  publication_status: "active" | "expired" | "revoked" | null;
  publication_revision_version: number | null;
  publication_expires_at: string | null;
  publication_id: string | null;
  publication_token_hash: string | null;
  publication_token_ciphertext: string | null;
  publication_token_nonce: string | null;
  publication_encryption_key_version: number | null;
  revision_metadata: string | null;
}

interface PublicationCiphertext {
  id: string;
  artifactId: string;
  tokenCiphertext: string | null;
  tokenNonce: string | null;
  encryptionKeyVersion: number | null;
}

interface ReconnectArtifactRow {
  cloud_artifact_id: string;
  title: string;
  lifecycle_state: "active" | "deleting";
}

export async function loadInventory(
  request: Request,
  env: Env,
): Promise<InventoryResponse> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE publications
        SET status = 'expired', token_ciphertext = NULL, token_nonce = NULL,
            encryption_key_version = NULL
      WHERE status = 'active' AND expires_at <= ?`,
  )
    .bind(now)
    .run();

  const result = await env.DB.prepare(
    `SELECT
       a.cloud_project_id AS project_id,
       a.cloud_artifact_id AS artifact_id,
       a.slug,
        a.title,
        a.kind,
        a.lifecycle_state,
       COUNT(DISTINCT CASE WHEN r.committed_at IS NOT NULL THEN r.id END)
         AS revision_count,
       COALESCE(SUM(CASE WHEN r.committed_at IS NOT NULL THEN f.byte_size ELSE 0 END), 0)
         AS storage_bytes,
        MAX(CASE WHEN r.committed_at IS NOT NULL THEN r.committed_at END)
          AS last_synced_at,
        (
          SELECT json_group_array(json_object(
            'version', committed.version,
            'createdAt', committed.created_at
          ))
          FROM local_revisions committed
          WHERE committed.artifact_id = a.cloud_artifact_id
            AND committed.committed_at IS NOT NULL
        ) AS revision_metadata,
       (
         SELECT CASE
           WHEN latest.revoked_at IS NOT NULL THEN 'revoked'
           WHEN latest.expires_at <= ? THEN 'expired'
           ELSE 'active'
         END
         FROM creator_links latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS creator_status,
       (
         SELECT latest.expires_at
         FROM creator_links latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS creator_expires_at,
       (
         SELECT latest.status
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_status,
       (
         SELECT latest.revision_version
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_revision_version,
       (
         SELECT latest.expires_at
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_expires_at,
       (
         SELECT latest.id
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_id,
       (
         SELECT latest.token_hash
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_token_hash,
       (
         SELECT latest.token_ciphertext
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_token_ciphertext,
       (
         SELECT latest.token_nonce
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_token_nonce,
       (
         SELECT latest.encryption_key_version
         FROM publications latest
         WHERE latest.artifact_id = a.cloud_artifact_id
         ORDER BY latest.created_at DESC
         LIMIT 1
       ) AS publication_encryption_key_version
     FROM sync_artifacts a
     LEFT JOIN local_revisions r ON r.artifact_id = a.cloud_artifact_id
     LEFT JOIN revision_files f ON f.revision_id = r.id
      GROUP BY a.cloud_project_id, a.cloud_artifact_id, a.slug, a.title, a.kind,
        a.lifecycle_state
     ORDER BY a.cloud_project_id ASC, a.slug ASC`,
  )
    .bind(now)
    .all<InventoryRow>();

  const projects = new Map<string, InventoryResponse["projects"][number]>();
  for (const row of result.results) {
    let project = projects.get(row.project_id);
    if (!project) {
      project = { projectId: row.project_id, artifacts: [] };
      projects.set(row.project_id, project);
    }

    const publicationStatus = row.publication_status ?? "none";
    const publication: InventoryResponse["projects"][number]["artifacts"][number]["publication"] =
      {
        status: publicationStatus,
        revisionVersion:
          row.publication_revision_version === null
            ? null
            : row.publication_revision_version,
        expiresAt: row.publication_expires_at,
        ...(publicationStatus === "active" &&
        row.publication_id &&
        row.publication_expires_at &&
        Date.parse(row.publication_expires_at) > Date.now()
          ? await recoverPublicUrl(request, env, row)
          : {}),
      };
    const warnings =
      publicationStatus === "active" &&
      row.publication_id &&
      row.publication_expires_at &&
      Date.parse(row.publication_expires_at) > Date.now() &&
      !("publicUrl" in publication)
        ? ["The active public URL could not be recovered."]
        : [];

    project.artifacts.push({
      artifactId: row.artifact_id,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      lifecycleState: row.lifecycle_state,
      revisionCount: row.revision_count,
      storageBytes: row.storage_bytes,
      lastSyncedAt: row.last_synced_at,
      creatorLink: {
        status: row.creator_status,
        expiresAt: row.creator_expires_at,
      },
      publication,
      revisions: row.revision_metadata
        ? (JSON.parse(row.revision_metadata) as Array<{
            version: number;
            createdAt: string;
          }>)
        : [],
      warnings,
    });
  }

  return inventoryResponseSchema.parse({ projects: [...projects.values()] });
}

async function recoverPublicUrl(
  request: Request,
  env: Env,
  row: InventoryRow,
): Promise<{ publicUrl?: string }> {
  if (!row.publication_id || !row.publication_token_hash) return {};
  const ciphertext: PublicationCiphertext = {
    id: row.publication_id,
    artifactId: row.artifact_id,
    tokenCiphertext: row.publication_token_ciphertext,
    tokenNonce: row.publication_token_nonce,
    encryptionKeyVersion: row.publication_encryption_key_version,
  };
  try {
    const token = await decryptPublicationToken(env, ciphertext);
    return {
      publicUrl: new URL(
        `/published/${encodeURIComponent(token)}`,
        request.url,
      ).toString(),
    };
  } catch {
    return {};
  }
}

export function inventoryResponse(
  value: InventoryResponse,
  status = 200,
): Response {
  return new Response(JSON.stringify(inventoryResponseSchema.parse(value)), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function rotateInventoryCreator(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok || !syncCreatorRotateRequestSchema.safeParse(body.value).success)
    return inventoryError(400, "Request validation failed");

  const rotated: InventoryCreatorRotation | Response =
    await rotateCreatorLinkForInventory(request, env, artifactId);
  if (rotated instanceof Response) return rotated;
  return inventoryJsonResponse(
    inventoryCreatorRotateResponseSchema.parse({
      cloudArtifactId: artifactId,
      creatorUrl: rotated.creatorUrl,
      creatorExpiresAt: rotated.creatorExpiresAt,
    }),
  );
}

export function reconnectCodeConfirmation(
  artifactId: string,
  title: string,
): string {
  return `RECOVER OWNER CREDENTIAL FOR ARTIFACT ${artifactId}: REDEMPTION REPLACES THE CURRENT OWNER CREDENTIAL (${title})`;
}

export async function issueInventoryReconnectCode(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<Response> {
  // Keep the Access check in the router ahead of this lookup and body read.
  const artifact = await env.DB.prepare(
    `SELECT cloud_artifact_id, title, lifecycle_state
       FROM sync_artifacts
      WHERE cloud_artifact_id = ?`,
  )
    .bind(artifactId)
    .first<ReconnectArtifactRow>();
  if (!artifact) return inventoryError(404, "Artifact not found");
  if (artifact.lifecycle_state === "deleting")
    return inventoryError(409, "Artifact deletion is in progress");

  const body = await readJson(request);
  if (!body.ok) return inventoryError(400, "Request validation failed");
  const parsed = inventoryReconnectCodeRequestSchema.safeParse(body.value);
  if (
    !parsed.success ||
    parsed.data.confirmation !==
      reconnectCodeConfirmation(artifactId, artifact.title)
  ) {
    return inventoryError(
      400,
      "Recovery confirmation did not match this Artifact",
    );
  }

  const reconnectCode = generateReconnectCode();
  const codeHash = await hashToken(reconnectCode);
  const createdAt = new Date();
  const createdAtValue = createdAt.toISOString();
  const expiresAt = new Date(
    createdAt.getTime() + RECONNECT_CODE_TTL_MS,
  ).toISOString();
  const [inserted, revoked] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO owner_reconnect_codes
        (id, artifact_id, code_hash, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM sync_artifacts
           WHERE cloud_artifact_id = ? AND lifecycle_state = 'active'
        )`,
    ).bind(
      `${RECONNECT_CODE_ID_PREFIX}${crypto.randomUUID()}`,
      artifactId,
      codeHash,
      createdAtValue,
      expiresAt,
      artifactId,
    ),
    env.DB.prepare(
      `UPDATE owner_reconnect_codes
          SET revoked_at = ?
        WHERE artifact_id = ? AND code_hash <> ?
          AND consumed_at IS NULL AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM owner_reconnect_codes
             WHERE artifact_id = ? AND code_hash = ?
          )
          AND EXISTS (
            SELECT 1 FROM sync_artifacts
             WHERE cloud_artifact_id = ? AND lifecycle_state = 'active'
          )`,
    ).bind(
      createdAtValue,
      artifactId,
      codeHash,
      artifactId,
      codeHash,
      artifactId,
    ),
  ]);
  if (inserted?.meta.changes !== 1 || revoked === undefined) {
    return inventoryError(409, "Artifact is unavailable for recovery");
  }

  return inventoryJsonResponse(
    inventoryReconnectCodeResponseSchema.parse({
      cloudArtifactId: artifactId,
      reconnectCode,
      expiresAt,
    }),
  );
}

export async function mutateInventoryPublicationRequest(
  request: Request,
  env: Env,
  artifactId: string,
  operation: "extend" | "republish" | "unpublish",
): Promise<Response> {
  const body =
    operation === "unpublish" && request.body === null
      ? { ok: true as const, value: {} }
      : await readJson(request);
  if (!body.ok) return inventoryError(400, "Request validation failed");
  if (operation === "unpublish") {
    if (request.method !== "POST")
      return inventoryError(405, "Method not allowed");
    if (
      !inventoryPublicationUnpublishRequestSchema.safeParse(body.value).success
    )
      return inventoryError(400, "Request validation failed");
    return mutatePublicationForInventory(env, artifactId, "unpublish");
  }
  const parsed = inventoryPublicationMutationRequestSchema.safeParse(
    body.value,
  );
  if (!parsed.success) return inventoryError(400, "Request validation failed");
  if (
    (operation === "extend" && parsed.data.revisionVersion !== undefined) ||
    (operation === "republish" && parsed.data.revisionVersion === undefined)
  ) {
    return inventoryError(400, "Request validation failed");
  }
  return mutatePublicationForInventory(env, artifactId, operation, parsed.data);
}

export function inventoryJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function inventoryError(status: number, message: string): Response {
  return inventoryJsonResponse(
    {
      error: {
        code: "VALIDATION_ERROR",
        message,
      },
    },
    status,
  );
}

function generateReconnectCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${RECONNECT_CODE_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return { ok: false };
  try {
    const text = await readBoundedText(request, INVENTORY_BODY_LIMIT);
    if (text === undefined) return { ok: false };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
