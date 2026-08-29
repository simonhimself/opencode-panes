import {
  inventoryCloudDeletionRequestSchema,
  type ApiErrorCode,
} from "@opencode-panes/contracts";
import { privateRevisionObjectKey } from "./storage";
import { readBoundedText } from "./bounded-json";

const DELETION_LEASE_TTL_MS = 60 * 1000;
const R2_DELETE_BATCH_SIZE = 1000;
const D1_LEDGER_UPDATE_BATCH_SIZE = 100;
const DELETION_BODY_LIMIT = 4096;

interface ArtifactRow {
  cloud_artifact_id: string;
  cloud_project_id: string;
  local_project_id: string;
  local_artifact_id: string;
  slug: string;
  title: string;
  kind: string | null;
  lifecycle_state: "active" | "deleting";
}

interface TombstoneRow {
  cloud_artifact_id: string;
  cloud_project_id: string;
  local_project_id: string;
  local_artifact_id: string;
  slug: string;
  title: string;
  kind: string | null;
  completed_at: string | null;
}

interface UploadRow {
  revision_version: number;
  path: string;
  object_key: string;
}

export async function deleteInventoryArtifact(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<Response> {
  const body = await parseBody(request);
  if (!body.ok) return errorResponse(400, "Request validation failed");

  const artifact = await env.DB.prepare(
    `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
            local_artifact_id, slug, title, kind, lifecycle_state
       FROM sync_artifacts WHERE cloud_artifact_id = ?`,
  )
    .bind(artifactId)
    .first<ArtifactRow>();
  const tombstone = await env.DB.prepare(
    `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
            local_artifact_id, slug, title, kind, completed_at
       FROM artifact_deletion_tombstones WHERE cloud_artifact_id = ?`,
  )
    .bind(artifactId)
    .first<TombstoneRow>();
  const title = artifact?.title ?? tombstone?.title;
  if (!title) return errorResponse(404, "Artifact not found");
  if (body.value.confirmation !== cloudDeletionConfirmation(title)) {
    return errorResponse(400, "The cloud deletion confirmation is not exact");
  }
  if (tombstone?.completed_at) return new Response(null, { status: 204 });
  if (!artifact && tombstone) return processDeletion(env, tombstone, request);
  if (!artifact) return errorResponse(404, "Artifact not found");

  const lease = await acquireDeletionLeases(env.DB, artifactId);
  if (!lease)
    return errorResponse(409, "Sync Artifact is busy; retry deletion");
  try {
    const current = await env.DB.prepare(
      `SELECT cloud_artifact_id, cloud_project_id, local_project_id,
            local_artifact_id, slug, title, kind, lifecycle_state
       FROM sync_artifacts WHERE cloud_artifact_id = ?`,
    )
      .bind(artifactId)
      .first<ArtifactRow>();
    if (!current) {
      return processDeletion(
        env,
        tombstone ?? artifactToTombstone(artifact),
        request,
      );
    }
    await ensureDeletionLedger(env, current);
    return processDeletion(env, current, request);
  } finally {
    await releaseDeletionLeases(env.DB, artifactId, lease);
  }
}

export async function deleteLegacyInventoryArtifact(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<Response> {
  const body = await parseBody(request);
  if (!body.ok) return errorResponse(400, "Request validation failed");

  const artifact = await env.DB.prepare(
    `SELECT a.title
       FROM legacy_artifacts legacy
       JOIN artifacts a ON a.id = legacy.artifact_id
      WHERE legacy.artifact_id = ?`,
  )
    .bind(artifactId)
    .first<{ title: string }>();
  if (!artifact) return errorResponse(404, "Artifact not found");
  if (body.value.confirmation !== cloudDeletionConfirmation(artifact.title)) {
    return errorResponse(400, "The cloud deletion confirmation is not exact");
  }

  const adoptionTable = await env.DB.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'legacy_adoption_grants'",
  ).first<{ present: number }>();
  if (adoptionTable) {
    await env.DB.batch([
      env.DB.prepare(
        // A consumed, bound grant may be needed to finish its local-first
        // Sync after the Legacy source disappears. Its expiry remains the
        // bound on that in-progress handoff.
        `UPDATE legacy_adoption_grants
            SET revoked_at = ?
          WHERE legacy_artifact_id = ? AND consumed_at IS NULL
            AND revoked_at IS NULL`,
      ).bind(new Date().toISOString(), artifactId),
      env.DB.prepare("DELETE FROM artifacts WHERE id = ?").bind(artifactId),
    ]);
  } else {
    await env.DB.prepare("DELETE FROM artifacts WHERE id = ?")
      .bind(artifactId)
      .run();
  }
  return new Response(null, { status: 204 });
}

export function cloudDeletionConfirmation(title: string): string {
  return `DELETE CLOUD COPY OF ${title}`;
}

async function acquireDeletionLeases(
  db: D1Database,
  artifactId: string,
): Promise<string | false> {
  const owner = `deletion-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + DELETION_LEASE_TTL_MS).toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE sync_artifacts
            SET lifecycle_state = 'deleting', sync_lease_owner = ?,
                sync_lease_expires_at = ?, publication_lease_owner = ?,
                publication_lease_expires_at = ?, updated_at = ?
          WHERE cloud_artifact_id = ?
            AND (sync_lease_owner IS NULL OR sync_lease_expires_at <= ?)
            AND (publication_lease_owner IS NULL OR publication_lease_expires_at <= ?)
            AND lifecycle_state IN ('active', 'deleting')`,
      )
      .bind(owner, expires, owner, expires, now, artifactId, now, now),
    db
      .prepare(
        `UPDATE creator_links SET revoked_at = ?
          WHERE artifact_id = ? AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM sync_artifacts
               WHERE cloud_artifact_id = ? AND lifecycle_state = 'deleting'
                 AND sync_lease_owner = ? AND publication_lease_owner = ?
            )`,
      )
      .bind(now, artifactId, artifactId, owner, owner),
    db
      .prepare(
        `UPDATE publications
            SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE status END,
                revoked_at = CASE WHEN status = 'active' THEN ? ELSE revoked_at END,
                token_ciphertext = NULL, token_nonce = NULL,
                encryption_key_version = NULL
          WHERE artifact_id = ?
            AND EXISTS (
              SELECT 1 FROM sync_artifacts
               WHERE cloud_artifact_id = ? AND lifecycle_state = 'deleting'
                 AND sync_lease_owner = ? AND publication_lease_owner = ?
            )`,
      )
      .bind(now, artifactId, artifactId, owner, owner),
  ]);
  return results[0]?.meta.changes === 1 ? owner : false;
}

async function releaseDeletionLeases(
  db: D1Database,
  artifactId: string,
  owner: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_artifacts
          SET sync_lease_owner = NULL, sync_lease_expires_at = NULL,
              publication_lease_owner = NULL, publication_lease_expires_at = NULL
        WHERE cloud_artifact_id = ? AND sync_lease_owner = ?`,
    )
    .bind(artifactId, owner)
    .run();
}

async function ensureDeletionLedger(env: Env, artifact: ArtifactRow) {
  const tombstone = artifactToTombstone(artifact);
  const revisions = await env.DB.prepare(
    `SELECT cloud_manifest_key FROM local_revisions
      WHERE artifact_id = ? AND cloud_manifest_key IS NOT NULL`,
  )
    .bind(artifact.cloud_artifact_id)
    .all<{ cloud_manifest_key: string }>();
  const files = await env.DB.prepare(
    `SELECT object_key FROM revision_files f
      JOIN local_revisions r ON r.id = f.revision_id
     WHERE r.artifact_id = ?`,
  )
    .bind(artifact.cloud_artifact_id)
    .all<{ object_key: string }>();
  const uploads = await env.DB.prepare(
    `SELECT revision_version, path, object_key FROM sync_uploads
      WHERE artifact_id = ?`,
  )
    .bind(artifact.cloud_artifact_id)
    .all<UploadRow>();
  const keys = new Set<string>([
    ...revisions.results.map((row) => row.cloud_manifest_key),
    ...files.results.map((row) => row.object_key),
    ...uploads.results.flatMap((row) => [
      row.object_key,
      privateRevisionObjectKey(
        artifact.cloud_project_id,
        artifact.cloud_artifact_id,
        `sync_revision_${artifact.cloud_artifact_id}_${row.revision_version}`,
        row.path,
      ),
    ]),
  ]);
  const statements = [
    env.DB.prepare(
      `INSERT INTO artifact_deletion_tombstones
        (cloud_artifact_id, cloud_project_id, local_project_id,
         local_artifact_id, slug, title, kind, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cloud_artifact_id) DO NOTHING`,
    ).bind(
      tombstone.cloud_artifact_id,
      tombstone.cloud_project_id,
      tombstone.local_project_id,
      tombstone.local_artifact_id,
      tombstone.slug,
      tombstone.title,
      tombstone.kind,
      new Date().toISOString(),
    ),
    ...[...keys].map((objectKey) =>
      env.DB.prepare(
        `INSERT INTO artifact_deletion_objects
          (cloud_artifact_id, object_key) VALUES (?, ?)
          ON CONFLICT(cloud_artifact_id, object_key) DO NOTHING`,
      ).bind(artifact.cloud_artifact_id, objectKey),
    ),
  ];
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100));
  }
}

async function processDeletion(
  env: Env,
  artifact: ArtifactRow | TombstoneRow,
  _request: Request,
): Promise<Response> {
  const pending = await env.DB.prepare(
    `SELECT object_key FROM artifact_deletion_objects
      WHERE cloud_artifact_id = ? AND deleted_at IS NULL
      ORDER BY object_key ASC LIMIT ?`,
  )
    .bind(artifact.cloud_artifact_id, R2_DELETE_BATCH_SIZE)
    .all<{ object_key: string }>();
  const deletable: string[] = [];
  const skipped: string[] = [];
  for (const row of pending.results) {
    if (
      await hasExternalReference(
        env.DB,
        artifact.cloud_artifact_id,
        row.object_key,
      )
    )
      skipped.push(row.object_key);
    else deletable.push(row.object_key);
  }
  if (deletable.length > 0) await env.PRIVATE_ARTIFACTS.delete(deletable);
  const completedKeys = [...skipped, ...deletable];
  for (
    let offset = 0;
    offset < completedKeys.length;
    offset += D1_LEDGER_UPDATE_BATCH_SIZE
  ) {
    const batch = completedKeys.slice(
      offset,
      offset + D1_LEDGER_UPDATE_BATCH_SIZE,
    );
    await env.DB.batch(
      batch.map((objectKey) =>
        env.DB.prepare(
          `UPDATE artifact_deletion_objects SET deleted_at = ?
            WHERE cloud_artifact_id = ? AND object_key = ? AND deleted_at IS NULL`,
        ).bind(new Date().toISOString(), artifact.cloud_artifact_id, objectKey),
      ),
    );
  }

  const remaining = await env.DB.prepare(
    `SELECT 1 FROM artifact_deletion_objects
      WHERE cloud_artifact_id = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(artifact.cloud_artifact_id)
    .first();
  if (remaining) return new Response(null, { status: 202 });
  await finalizeDeletion(env, artifact);
  return new Response(null, { status: 204 });
}

async function hasExternalReference(
  db: D1Database,
  artifactId: string,
  objectKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
         FROM revision_files f
         JOIN local_revisions r ON r.id = f.revision_id
        WHERE f.object_key = ? AND r.artifact_id <> ?
       UNION ALL
       SELECT 1 AS found FROM local_revisions
        WHERE cloud_manifest_key = ? AND artifact_id <> ?
       LIMIT 1`,
    )
    .bind(objectKey, artifactId, objectKey, artifactId)
    .first<{ found: number }>();
  return Boolean(row);
}

async function finalizeDeletion(
  env: Env,
  artifact: ArtifactRow | TombstoneRow,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM revision_files WHERE revision_id IN
        (SELECT id FROM local_revisions WHERE artifact_id = ?)`,
    ).bind(artifact.cloud_artifact_id),
    env.DB.prepare("DELETE FROM local_revisions WHERE artifact_id = ?").bind(
      artifact.cloud_artifact_id,
    ),
    env.DB.prepare("DELETE FROM sync_uploads WHERE artifact_id = ?").bind(
      artifact.cloud_artifact_id,
    ),
    env.DB.prepare("DELETE FROM publications WHERE artifact_id = ?").bind(
      artifact.cloud_artifact_id,
    ),
    env.DB.prepare("DELETE FROM creator_links WHERE artifact_id = ?").bind(
      artifact.cloud_artifact_id,
    ),
    env.DB.prepare("DELETE FROM local_artifacts WHERE id = ?").bind(
      artifact.cloud_artifact_id,
    ),
    env.DB.prepare(
      "DELETE FROM sync_artifacts WHERE cloud_artifact_id = ?",
    ).bind(artifact.cloud_artifact_id),
    env.DB.prepare(
      "DELETE FROM legacy_adoption_provenance WHERE cloud_artifact_id = ?",
    ).bind(artifact.cloud_artifact_id),
    env.DB.prepare(
      `DELETE FROM projects WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM local_artifacts WHERE project_id = ?)
        AND NOT EXISTS (SELECT 1 FROM sync_artifacts WHERE local_project_id = ?)`,
    ).bind(
      artifact.local_project_id,
      artifact.local_project_id,
      artifact.cloud_project_id,
    ),
    env.DB.prepare(
      "DELETE FROM artifact_deletion_objects WHERE cloud_artifact_id = ?",
    ).bind(artifact.cloud_artifact_id),
    env.DB.prepare(
      `UPDATE artifact_deletion_tombstones SET completed_at = ?
        WHERE cloud_artifact_id = ? AND completed_at IS NULL`,
    ).bind(now, artifact.cloud_artifact_id),
  ]);
}

function artifactToTombstone(artifact: ArtifactRow): TombstoneRow {
  return { ...artifact, completed_at: null };
}

async function parseBody(
  request: Request,
): Promise<{ ok: true; value: { confirmation: string } } | { ok: false }> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return { ok: false };
  try {
    const text = await readBoundedText(request, DELETION_BODY_LIMIT);
    if (text === undefined) return { ok: false };
    const parsed = inventoryCloudDeletionRequestSchema.safeParse(
      JSON.parse(text) as unknown,
    );
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code:
          status === 404
            ? "NOT_FOUND"
            : status === 409
              ? "CONFLICT"
              : "VALIDATION_ERROR",
        message,
      },
    } satisfies { error: { code: ApiErrorCode; message: string } }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
