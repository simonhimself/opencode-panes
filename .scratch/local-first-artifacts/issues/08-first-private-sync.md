# 08: Complete the first private Sync

**What to build:** Carry one valid finalized Revision through the complete first-Sync path. Create its cloud identity, persist scoped local ownership, derive a filtered cloud manifest, commit exact private files, and return an initial Creator link without publishing anything.

**Blocked by:** 04: Discover, reopen, and recover local Artifacts; 06: Enforce approved-origin preview security; 07: Expand private storage for file Revisions

**Status:** ready-for-agent

- [ ] First Sync uses the creation admission key and a stable idempotency key to create exactly one cloud Artifact, then uses a recoverable checkpoint to persist its non-secret mapping and protected Owner credential before upload.
- [ ] The canonical local manifest remains local; Sync derives a cloud manifest containing only the first uploaded Revision and files selected for upload.
- [ ] Mandatory exclusions prevent Drafts, secrets, Git internals, dependencies, and build caches from entering either uploaded bytes or the cloud manifest.
- [ ] One representative multi-file Revision reaches private object storage with exact text and binary bytes and becomes readable only after its per-Revision commit.
- [ ] When additional local Revisions exist, this initial slice commits only the earliest unsynced Revision and accurately reports the remaining history as pending.
- [ ] Custom ignore files and symlinks that this slice cannot yet evaluate fail closed rather than uploading unexpected content.
- [ ] Partial object upload never creates a visible Revision or public access.
- [ ] Basic server-side enforcement rejects files above 25 MB and Revisions above 100 MB without imposing local limits.
- [ ] Sync creates one fixed 30-day Creator link, returns the Creator and Cloud inventory addresses, and creates no Publication.
- [ ] `openCreatorAfterSuccess` defaults to false; when true, successful Sync attempts to open the Creator workspace and still returns its URL.
