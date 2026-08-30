-- Cloud inventory deletion is a durable, request-retryable operation.
ALTER TABLE sync_artifacts ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN ('active', 'deleting'));

CREATE TABLE artifact_deletion_tombstones (
  cloud_artifact_id TEXT PRIMARY KEY CHECK (length(cloud_artifact_id) BETWEEN 1 AND 128),
  cloud_project_id TEXT NOT NULL CHECK (length(cloud_project_id) BETWEEN 1 AND 128),
  local_project_id TEXT NOT NULL CHECK (length(local_project_id) BETWEEN 1 AND 128),
  local_artifact_id TEXT NOT NULL CHECK (length(local_artifact_id) BETWEEN 1 AND 128),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 128),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE artifact_deletion_objects (
  cloud_artifact_id TEXT NOT NULL
    REFERENCES artifact_deletion_tombstones (cloud_artifact_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  deleted_at TEXT,
  PRIMARY KEY (cloud_artifact_id, object_key)
);

CREATE INDEX artifact_deletion_objects_pending_idx
  ON artifact_deletion_objects (cloud_artifact_id, deleted_at);
