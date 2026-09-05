-- Fresh library namespace. Historical tables are deliberately not consulted.
CREATE TABLE library_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE library_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES library_projects(id),
  artifact_key TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX library_artifact_identity
  ON library_artifacts(project_id, artifact_key) WHERE deleted_at IS NULL;

CREATE TABLE library_uploads (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES library_artifacts(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX library_upload_artifact ON library_uploads(artifact_id);

-- A version ID is its upload ID; the manifest and object keys never change.
CREATE TABLE library_versions (
  id TEXT PRIMARY KEY REFERENCES library_uploads(id),
  artifact_id TEXT NOT NULL REFERENCES library_artifacts(id),
  number INTEGER NOT NULL CHECK(number > 0),
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, number)
);

CREATE TABLE library_shares (
  artifact_id TEXT PRIMARY KEY REFERENCES library_artifacts(id),
  token TEXT NOT NULL UNIQUE,
  version_id TEXT NOT NULL REFERENCES library_versions(id),
  expires_at TEXT
);
