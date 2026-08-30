-- Adoption capabilities contain only a short-lived hash and immutable source
-- metadata. The redeeming local IDs bind the capability to one local Artifact.
CREATE TABLE legacy_adoption_grants (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  legacy_artifact_id TEXT NOT NULL,
  legacy_revision_id TEXT NOT NULL,
  legacy_revision_version INTEGER NOT NULL CHECK (legacy_revision_version > 0),
  legacy_title TEXT NOT NULL CHECK (length(legacy_title) BETWEEN 1 AND 200),
  legacy_type TEXT NOT NULL CHECK (legacy_type IN ('html', 'react', 'svg', 'mermaid', 'markdown', 'code')),
  code_hash TEXT NOT NULL UNIQUE CHECK (
    length(code_hash) = 64
    AND code_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  local_project_id TEXT,
  local_artifact_id TEXT,
  local_slug TEXT,
  UNIQUE (local_project_id, local_artifact_id)
);

CREATE INDEX legacy_adoption_grants_expiry_idx
  ON legacy_adoption_grants (expires_at);

CREATE TABLE legacy_adoption_provenance (
  grant_id TEXT PRIMARY KEY,
  cloud_artifact_id TEXT NOT NULL UNIQUE,
  local_project_id TEXT NOT NULL,
  local_artifact_id TEXT NOT NULL,
  local_slug TEXT NOT NULL,
  legacy_artifact_id TEXT NOT NULL,
  legacy_revision_id TEXT NOT NULL,
  legacy_revision_version INTEGER NOT NULL CHECK (legacy_revision_version > 0),
  legacy_title TEXT NOT NULL CHECK (length(legacy_title) BETWEEN 1 AND 200),
  legacy_type TEXT NOT NULL CHECK (legacy_type IN ('html', 'react', 'svg', 'mermaid', 'markdown', 'code')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX legacy_adoption_provenance_local_idx
  ON legacy_adoption_provenance (local_project_id, local_artifact_id);
