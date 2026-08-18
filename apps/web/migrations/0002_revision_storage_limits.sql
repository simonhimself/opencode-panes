-- Keep these defense-in-depth limits synchronized with the exported contract constants.
CREATE TRIGGER revisions_enforce_storage_limits
BEFORE INSERT ON revisions
BEGIN
  SELECT CASE
    WHEN length(CAST(NEW.source AS BLOB)) > 1048576
      THEN RAISE(ABORT, 'ARTIFACT_SOURCE_TOO_LARGE')
    WHEN (SELECT COUNT(*) FROM revisions WHERE artifact_id = NEW.artifact_id) >= 16
      THEN RAISE(ABORT, 'ARTIFACT_REVISION_LIMIT')
    WHEN COALESCE(
      (SELECT SUM(length(CAST(source AS BLOB))) FROM revisions WHERE artifact_id = NEW.artifact_id),
      0
    ) + length(CAST(NEW.source AS BLOB)) > 2097152
      THEN RAISE(ABORT, 'ARTIFACT_TOTAL_SOURCE_LIMIT')
  END;
END;
