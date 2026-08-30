-- Local-first storage is intentionally separate from the legacy source-string
-- artifacts, revisions, and shares tables in migrations 0001 and 0002.
CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE local_artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 128),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind TEXT CHECK (kind IS NULL OR length(kind) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE INDEX local_artifacts_project_idx
  ON local_artifacts (project_id, updated_at DESC);

CREATE TABLE local_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  artifact_id TEXT NOT NULL REFERENCES local_artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  preview_entry TEXT NOT NULL
    CHECK (json_valid(preview_entry) AND json_type(preview_entry) = 'object'),
  approved_origins TEXT NOT NULL
    CHECK (json_valid(approved_origins) AND json_type(approved_origins) = 'array'),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE (artifact_id, id),
  UNIQUE (artifact_id, version)
);

CREATE INDEX local_revisions_artifact_version_idx
  ON local_revisions (artifact_id, version DESC);

CREATE TABLE revision_files (
  revision_id TEXT NOT NULL REFERENCES local_revisions (id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  sha256 TEXT NOT NULL
    CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 2048),
  PRIMARY KEY (revision_id, path)
);

CREATE INDEX revision_files_object_idx
  ON revision_files (object_key);
