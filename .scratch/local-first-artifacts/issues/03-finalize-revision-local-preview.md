# 03: Finalize an immutable Revision with a Local preview

**What to build:** Turn a complete Draft into the next immutable Revision only after its declared Preview entry works. Return a temporary loopback URL that lets the creator review the exact finalized files presented in the OpenCode conversation, with deterministic recovery from every interrupted promotion phase.

**Blocked by:** 02: Prepare a project Artifact Draft

**Status:** ready-for-agent

- [ ] Finalize accepts a normalized relative entry path plus either a direct-browser adapter or a supported Panes renderer adapter and rejects invalid combinations.
- [ ] Draft files are hashed as raw bytes and recorded with size, media type, directory, and portable mode metadata.
- [ ] Direct-browser entries serve HTML, SVG, and built output directly; Markdown, Mermaid, code, and supported single-file React entries use generated sandbox wrappers without transforming stored source.
- [ ] Successful validation writes and flushes a finalization journal, renames Draft to the next contiguous `vN`, atomically replaces the manifest, and removes the journal.
- [ ] Recovery recognizes crashes before rename, after rename, after manifest replacement, and before journal cleanup, then safely completes or rolls back the recorded phase after hash verification.
- [ ] A failed validation or interrupted promotion leaves prior Revisions unchanged and never exposes duplicate or partially recorded Revision numbers.
- [ ] Finalized Revision changes, deletions, numbering gaps, and manifest mismatches are detected and block preview or Sync.
- [ ] The Preview server binds only to `127.0.0.1`, uses an operating-system-assigned port and unguessable path, serves nested assets with correct media types, and stops with the Panes process.
- [ ] The returned URL addresses the finalized Revision, not the temporary Draft.
- [ ] Finalize and Local preview make no Cloudflare request.
