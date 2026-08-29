-- Sync recovery keeps leases, upload receipts, and Creator capabilities
-- separate from legacy artifact and credential columns.
ALTER TABLE sync_artifacts ADD COLUMN sync_lease_owner TEXT;
ALTER TABLE sync_artifacts ADD COLUMN sync_lease_expires_at TEXT;

CREATE TABLE creator_links (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  artifact_id TEXT NOT NULL REFERENCES sync_artifacts (cloud_artifact_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (artifact_id, token_hash)
);

CREATE UNIQUE INDEX creator_links_one_active_idx
  ON creator_links (artifact_id)
  WHERE revoked_at IS NULL;

-- Existing Sync artifacts retain their legacy credential columns and gain a
-- history row so old Creator links resolve to 410 after expiry or revocation.
INSERT INTO creator_links (id, artifact_id, token_hash, created_at, expires_at)
SELECT cloud_artifact_id, cloud_artifact_id, creator_token_hash,
       creator_created_at, creator_expires_at
  FROM sync_artifacts;

CREATE TABLE sync_uploads (
  artifact_id TEXT NOT NULL REFERENCES sync_artifacts (cloud_artifact_id) ON DELETE CASCADE,
  revision_version INTEGER NOT NULL CHECK (revision_version > 0),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
  expected_byte_size INTEGER NOT NULL CHECK (expected_byte_size >= 0),
  expected_media_type TEXT NOT NULL CHECK (length(expected_media_type) BETWEEN 1 AND 256),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 2048),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision_version, path)
);

CREATE INDEX sync_uploads_cleanup_idx
  ON sync_uploads (created_at);
