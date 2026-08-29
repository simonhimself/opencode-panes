# 23: Run final release verification

**What to build:** Run the complete repository and Cloudflare verification suite against the accepted, documented local-first implementation. Resolve failures at their owning ticket before declaring the feature ready.

**Blocked by:** 22: Update local-first documentation and supersede the old plan

**Status:** ready-for-agent

- [ ] Formatting passes without modifying unrelated files.
- [ ] Type checking passes across every workspace.
- [ ] All plugin, Worker, viewer, migration, and contract tests pass together.
- [ ] Production web and standalone plugin builds pass.
- [ ] The installed-plugin smoke check passes without repository runtime imports or dependencies.
- [ ] The Worker deployment dry run succeeds with D1, private R2, and Access configuration.
- [ ] Git status and the final diff contain only intended feature and documentation changes, with no credentials, local state, generated deployment output, or ignored metadata.
