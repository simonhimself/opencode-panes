# 11: Open synced Revisions in the Creator workspace

**What to build:** Let a Creator-link holder privately inspect every synced Revision as a working Preview or a safe file tree. Creator access remains a bounded bearer capability and never exposes private object storage directly.

**Blocked by:** 10: Harden Sync recovery and Creator-link lifecycle

**Status:** ready-for-agent

- [ ] A valid Creator link can list and select every synced Revision for its Artifact.
- [ ] Preview serves the selected Revision and nested assets from private storage with the approved sandbox and network policy.
- [ ] Direct-browser and Panes-renderer Preview adapters use the same policy inputs and produce behavior equivalent to the validated Local preview.
- [ ] Files displays normalized paths and highlighted text content; binary entries show type, size, and a download action instead of unsafe decoding.
- [ ] File requests cannot traverse paths, list raw storage, or access another Artifact or Revision.
- [ ] Creator-link reuse does not extend expiry, and rotation invalidates the previous token.
- [ ] Expired or revoked Creator links return `410 Gone` through the existing status view; unknown tokens return `404 Not Found`.
- [ ] Capability responses are non-cacheable, use a no-referrer policy, and redact tokens from logs and errors.
- [ ] Creator access cannot synchronize Revisions or permanently delete cloud data.
