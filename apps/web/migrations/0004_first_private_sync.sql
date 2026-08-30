-- First private Sync keeps local-first cloud identity and capability hashes
-- separate from the legacy source-string artifact tables.
CREATE TABLE sync_artifacts (
  cloud_artifact_id TEXT PRIMARY KEY CHECK (length(cloud_artifact_id) BETWEEN 1 AND 128),
  cloud_project_id TEXT NOT NULL CHECK (length(cloud_project_id) BETWEEN 1 AND 128),
  local_project_id TEXT NOT NULL CHECK (length(local_project_id) BETWEEN 1 AND 128),
  local_artifact_id TEXT NOT NULL CHECK (length(local_artifact_id) BETWEEN 1 AND 128),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 128),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind TEXT CHECK (kind IS NULL OR length(kind) BETWEEN 1 AND 64),
  owner_token_hash TEXT NOT NULL CHECK (length(owner_token_hash) = 64),
  creation_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(creation_idempotency_key) BETWEEN 1 AND 256),
  creator_token_hash TEXT NOT NULL CHECK (length(creator_token_hash) = 64),
  creator_created_at TEXT NOT NULL,
  creator_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (local_project_id, local_artifact_id),
  UNIQUE (cloud_project_id, slug)
);

CREATE INDEX sync_artifacts_project_idx
  ON sync_artifacts (cloud_project_id, updated_at DESC);

ALTER TABLE local_revisions ADD COLUMN cloud_manifest_key TEXT;
