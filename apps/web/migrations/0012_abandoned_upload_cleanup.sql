-- Retain denial receipts, but release expired request keys for fresh retries.
-- Existing uploads (including committed versions) remain unexpired.
ALTER TABLE library_uploads ADD COLUMN expired_at TEXT;
ALTER TABLE library_uploads ADD COLUMN cleanup_checked_at TEXT;

CREATE INDEX library_upload_cleanup_order
  ON library_uploads(COALESCE(cleanup_checked_at, created_at), id);
