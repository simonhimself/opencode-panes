# 06: Enforce approved-origin preview security

**What to build:** Give Local previews the same default-deny browser boundary expected in the cloud. A Revision may use only explicitly approved HTTP or HTTPS origins, and unsafe paths, redirects, schemes, and symlinks never escape the Artifact sandbox.

**Blocked by:** 03: Finalize an immutable Revision with a Local preview

**Status:** ready-for-agent

- [ ] Preview blocks external network access when no origin is approved.
- [ ] A Finalize request declares normalized requested origins separately from finalized Artifact metadata.
- [ ] Finalize returns an approval-required result and a nonce bound to the Draft hashes and exact requested-origin set, and performs no promotion before approval.
- [ ] A confirmed second call accepts only the unchanged Draft and exact approved set, then records approved origins as immutable Revision metadata.
- [ ] Browser policy derives the required connection, image, media, font, style, and script restrictions from approved origins.
- [ ] Redirects to unapproved origins and all unsupported schemes remain blocked; `ws` and `wss` are unsupported initially even when the matching HTTP origin is approved.
- [ ] Traversal, absolute paths, path aliases, broken links, escaping symlinks, and symlink-race attempts cannot read outside the locked Revision snapshot.
- [ ] Shared policy inputs and evaluators are reusable by future Creator and public routes; this ticket verifies Local behavior only.
