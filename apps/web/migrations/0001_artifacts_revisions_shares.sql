CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_token_hash TEXT NOT NULL CHECK (length(owner_token_hash) = 64),
  workspace_token_hash TEXT NOT NULL CHECK (length(workspace_token_hash) = 64),
  opencode_session_id TEXT NOT NULL CHECK (length(opencode_session_id) BETWEEN 1 AND 256),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  type TEXT NOT NULL CHECK (type IN ('html', 'react', 'svg', 'mermaid', 'markdown', 'code')),
  current_revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (id, current_revision_id)
    REFERENCES revisions (artifact_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  source TEXT NOT NULL CHECK (length(CAST(source AS BLOB)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, id),
  UNIQUE (artifact_id, version)
);

CREATE INDEX revisions_artifact_version_idx
  ON revisions (artifact_id, version DESC);

CREATE TABLE shares (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (artifact_id, revision_id)
    REFERENCES revisions (artifact_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX shares_one_active_per_artifact_idx
  ON shares (artifact_id)
  WHERE revoked_at IS NULL;

CREATE INDEX shares_artifact_created_idx
  ON shares (artifact_id, created_at DESC);

CREATE INDEX shares_revision_idx
  ON shares (revision_id);
