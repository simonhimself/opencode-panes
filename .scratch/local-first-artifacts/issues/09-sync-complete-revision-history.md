# 09: Sync complete Revision history safely

**What to build:** Extend the first private Sync to every unsynced finalized Revision while applying the complete file-selection policy. Exact uploaded bytes and the filtered cloud manifest must agree, and a failure in later history must not hide already committed Revisions.

**Blocked by:** 08: Complete the first private Sync

**Status:** ready-for-agent

- [ ] Sync uploads every unsynced finalized Revision in local version order and preserves local numbering.
- [ ] Exact text and binary bytes, including line endings, byte-order marks, empty files, and final newlines, survive round-trip retrieval.
- [ ] `.panesignore` uses ordered Artifact-root-relative Gitignore semantics where the last user match wins but negation cannot restore mandatory exclusions.
- [ ] `.panesignore` itself is not uploaded, ignored files do not count toward limits, and its rules apply only to Revision content.
- [ ] The cloud manifest is deterministically derived from the canonical local manifest and contains only uploaded Revisions and file entries; ignored paths, names, hashes, and sizes are absent.
- [ ] Broken or escaping symlinks fail safely, while valid internal symlinks are snapshotted once as regular file bytes.
- [ ] File and Revision limits are enforced after ignore evaluation at 25 MB and 100 MB with boundary coverage.
- [ ] Transactional visibility is per Revision. After each commit, the cloud manifest describes exactly the committed history; a failed later upload leaves earlier Revisions visible and the remaining local history unsynced.
