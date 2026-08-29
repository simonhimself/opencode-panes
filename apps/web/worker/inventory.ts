import {
  inventoryResponseSchema,
  type InventoryResponse,
} from "@opencode-panes/contracts";
import { decryptPublicationToken } from "./publication";

interface InventoryRow {
  project_id: string;
  artifact_id: string;
  slug: string;
  title: string;
  kind: string | null;
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
}

interface PublicationCiphertext {
  id: string;
  artifactId: string;
  tokenCiphertext: string | null;
  tokenNonce: string | null;
  encryptionKeyVersion: number | null;
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
       COUNT(DISTINCT CASE WHEN r.committed_at IS NOT NULL THEN r.id END)
         AS revision_count,
       COALESCE(SUM(CASE WHEN r.committed_at IS NOT NULL THEN f.byte_size ELSE 0 END), 0)
         AS storage_bytes,
       MAX(CASE WHEN r.committed_at IS NOT NULL THEN r.committed_at END)
         AS last_synced_at,
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
     GROUP BY a.cloud_project_id, a.cloud_artifact_id, a.slug, a.title, a.kind
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
      revisionCount: row.revision_count,
      storageBytes: row.storage_bytes,
      lastSyncedAt: row.last_synced_at,
      creatorLink: {
        status: row.creator_status,
        expiresAt: row.creator_expires_at,
      },
      publication,
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
