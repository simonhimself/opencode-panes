export const LEGACY_PRIVATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LEGACY_PUBLIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LegacyArtifactRow {
  artifact_id: string;
  migrated_at: string;
  private_expires_at: string;
}

export async function backfillLegacyClassification(
  db: D1Database,
  migratedAt = new Date().toISOString(),
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO legacy_migration_state (id, migrated_at)
         VALUES (1, ?)`,
      )
      .bind(migratedAt),
    db.prepare(
      `INSERT OR IGNORE INTO legacy_artifacts
        (artifact_id, migrated_at, private_expires_at)
       SELECT a.id, state.migrated_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', julianday(state.migrated_at) + 30.0)
         FROM artifacts a
         CROSS JOIN legacy_migration_state state
        WHERE state.id = 1`,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO legacy_shares
        (token_hash, artifact_id, migrated_at, public_expires_at)
       SELECT s.token_hash, s.artifact_id, state.migrated_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', julianday(state.migrated_at) + 7.0)
         FROM shares s
         CROSS JOIN legacy_migration_state state
        WHERE state.id = 1`,
    ),
  ]);
}

export async function getLegacyArtifact(
  db: D1Database,
  artifactId: string,
): Promise<LegacyArtifactRow | null> {
  return db
    .prepare(
      `SELECT artifact_id, migrated_at, private_expires_at
         FROM legacy_artifacts
        WHERE artifact_id = ?`,
    )
    .bind(artifactId)
    .first<LegacyArtifactRow>();
}

export async function listLegacyArtifacts(
  db: D1Database,
): Promise<LegacyArtifactRow[]> {
  const result = await db
    .prepare(
      `SELECT artifact_id, migrated_at, private_expires_at
         FROM legacy_artifacts
        ORDER BY artifact_id ASC`,
    )
    .all<LegacyArtifactRow>();
  return result.results;
}
