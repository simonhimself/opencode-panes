-- Local-first Publications are separate from legacy source-string shares.
ALTER TABLE sync_artifacts ADD COLUMN publication_lease_owner TEXT;
ALTER TABLE sync_artifacts ADD COLUMN publication_lease_expires_at TEXT;

CREATE TABLE publications (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  artifact_id TEXT NOT NULL REFERENCES sync_artifacts (cloud_artifact_id) ON DELETE CASCADE,
  revision_version INTEGER NOT NULL CHECK (revision_version > 0),
  duration_days INTEGER NOT NULL CHECK (duration_days IN (1, 7, 30)),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  token_ciphertext TEXT,
  token_nonce TEXT CHECK (token_nonce IS NULL OR (length(token_nonce) = 24 AND token_nonce NOT GLOB '*[^0-9a-f]*')),
  encryption_key_version INTEGER CHECK (encryption_key_version IS NULL OR encryption_key_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (artifact_id, revision_version)
    REFERENCES local_revisions (artifact_id, version) ON DELETE CASCADE
);

CREATE UNIQUE INDEX publications_one_active_idx
  ON publications (artifact_id)
  WHERE status = 'active';

CREATE INDEX publications_artifact_history_idx
  ON publications (artifact_id, created_at DESC);
