# 18: Migrate cloud-first Artifacts to read-only Legacy artifacts

**What to build:** Preserve existing cloud-first Artifacts as readable Legacy artifacts while ending permanent access and source-string revision. Migration runs once, assigns bounded expiry, and makes the legacy state clear in private views.

**Blocked by:** 12: Publish one selected Revision with explicit expiry; 15: Build the authenticated Cloud inventory

**Status:** ready-for-agent

- [ ] Migration records one stable timestamp and classifies every existing source-string Artifact as Legacy.
- [ ] Existing legacy Creator links expire 30 days after the migration timestamp and existing public links expire 7 days after it.
- [ ] Rerunning migration does not reset or extend any expiry.
- [ ] Legacy Revisions remain readable through their existing renderer behavior until their scoped access expires.
- [ ] New source-string revision mutation is rejected for migrated Legacy artifacts while reads and explicit cloud deletion remain supported.
- [ ] The Cloud inventory groups and labels Legacy artifacts separately with their expiry and Publication state.
- [ ] Creator and public Legacy expiry use the same safe status-state behavior as local-first links.
- [ ] Migration tests begin from the applied legacy schema and prove no source or publication history is lost.
