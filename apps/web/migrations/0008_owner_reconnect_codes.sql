-- Reconnect codes are short-lived, single-use capabilities for replacing an
-- Owner credential. Only their hashes and non-secret lifecycle metadata live
-- in D1.
CREATE TABLE owner_reconnect_codes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  artifact_id TEXT NOT NULL
    REFERENCES sync_artifacts (cloud_artifact_id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK (
    length(code_hash) = 64
    AND code_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);

CREATE INDEX owner_reconnect_codes_artifact_idx
  ON owner_reconnect_codes (artifact_id, created_at DESC);
