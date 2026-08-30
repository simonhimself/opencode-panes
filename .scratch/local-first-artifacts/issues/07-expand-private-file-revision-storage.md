# 07: Expand private storage for file Revisions

**What to build:** Add only the persistence primitives required for a later Sync slice to store immutable multi-file Revisions. This is an intentional expand step, not a user workflow; existing source-string Artifacts must remain green beside it.

**Blocked by:** 01: Expand local-first contracts beside legacy contracts

**Status:** ready-for-agent

- [ ] Additive database changes represent projects, local-first Artifacts, committed Revisions, and Revision files without rewriting applied migrations.
- [ ] Private object storage is configured for exact file bytes, and no bucket or object namespace is publicly accessible.
- [ ] File metadata records normalized path, hash, raw byte size, media type, and committed object identity.
- [ ] Storage primitives can write and read exact text, binary, empty, and maximum-boundary file objects through local test bindings.
- [ ] The schema permits a later per-Revision commit point without prematurely adding upload, credential, Creator-link, or Publication behavior.
- [ ] Existing cloud-first creation, revision, creator, and public routes continue to pass their compatibility tests.
