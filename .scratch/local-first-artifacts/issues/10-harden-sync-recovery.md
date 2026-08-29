# 10: Harden Sync recovery and Creator-link lifecycle

**What to build:** Make repeated, interrupted, and concurrent Sync safe after complete-history upload works. Recover first-Sync identity checkpoints, resume temporary uploads, serialize commits, clean abandoned objects, and enforce the full Creator-link lifecycle.

**Blocked by:** 09: Sync complete Revision history safely

**Status:** ready-for-agent

- [ ] Retrying a crash during any first-Sync checkpoint phase recovers the same cloud identity and credential state rather than creating a duplicate Artifact.
- [ ] Interrupted multi-Revision Sync resumes from the first uncommitted Revision without re-uploading verified matching objects.
- [ ] Idempotent replays return existing committed Revisions when hashes match and reject conflicting bytes for an existing Revision number.
- [ ] Local Artifact locking and a server-side transaction or lease prevent concurrent Sync requests from racing one cloud Artifact.
- [ ] Temporary upload objects remain invisible and scheduled cleanup removes abandoned objects after a grace period without deleting committed references.
- [ ] A valid Creator link is reused without extending its fixed expiry; explicit rotation revokes it and issues one replacement with a new 30-day expiry.
- [ ] Expired or revoked Creator links cannot read or mutate the Artifact, and Sync or authenticated inventory action can issue the permitted replacement.
- [ ] Owner credentials and Creator tokens remain outside manifests and are redacted from logs, analytics, and errors.
