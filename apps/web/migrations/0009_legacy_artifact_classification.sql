CREATE TABLE IF NOT EXISTS legacy_migration_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  migrated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_artifacts (
  artifact_id TEXT PRIMARY KEY
    REFERENCES artifacts (id) ON DELETE CASCADE,
  migrated_at TEXT NOT NULL,
  private_expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_shares (
  token_hash TEXT PRIMARY KEY
    REFERENCES shares (token_hash) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL
    REFERENCES artifacts (id) ON DELETE CASCADE,
  migrated_at TEXT NOT NULL,
  public_expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS legacy_artifacts_expiry_idx
  ON legacy_artifacts (private_expires_at);

CREATE INDEX IF NOT EXISTS legacy_shares_expiry_idx
  ON legacy_shares (public_expires_at);

INSERT OR IGNORE INTO legacy_migration_state (id, migrated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO legacy_artifacts
  (artifact_id, migrated_at, private_expires_at)
SELECT a.id,
       state.migrated_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',
         julianday(state.migrated_at) + 30.0)
  FROM artifacts a
  CROSS JOIN legacy_migration_state state
 WHERE state.id = 1;

INSERT OR IGNORE INTO legacy_shares
  (token_hash, artifact_id, migrated_at, public_expires_at)
SELECT s.token_hash,
       s.artifact_id,
       state.migrated_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',
         julianday(state.migrated_at) + 7.0)
  FROM shares s
  CROSS JOIN legacy_migration_state state
 WHERE state.id = 1;
