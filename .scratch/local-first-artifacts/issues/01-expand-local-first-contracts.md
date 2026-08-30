# 01: Expand local-first contracts beside legacy contracts

**What to build:** Introduce the shared vocabulary and validation rules needed for project-local, multi-file Artifacts while keeping every existing cloud-first contract usable. This is the expand step that lets later slices migrate one behavior at a time without breaking current users.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Valid local-first contracts cover Artifact manifests, Drafts, finalized Revisions, files, direct-browser and Panes-renderer Preview entries, Sync state, Owner credentials, Creator links, and Publications.
- [ ] A distinct cloud-manifest contract can be derived from canonical local metadata and cannot represent files excluded from the upload set.
- [ ] Relative-path validation rejects absolute paths, traversal, control characters, duplicate normalized paths, and platform aliases that collide.
- [ ] Hashes, raw byte sizes, identifiers, revision numbers, and approved origins have explicit validation rules and boundary tests.
- [ ] Requested Draft origins and immutable approved Revision origins are distinct contract states.
- [ ] Legacy Artifact, Revision, creator, and public-share contracts continue to parse and behave as before.
- [ ] Local-first contracts do not inherit the legacy source-size, revision-count, or aggregate-source limits.
- [ ] Shared terminology matches the project domain glossary.
