# 23: Run final release verification

**What to build:** Run the complete repository and Cloudflare verification suite against the accepted, documented local-first implementation. Resolve failures at their owning ticket before declaring the feature ready.

**Blocked by:** 22: Update local-first documentation and supersede the old plan

**Status:** done

- [x] Formatting passes without modifying unrelated files.
- [x] Type checking passes across every workspace.
- [x] All plugin, Worker, viewer, migration, and contract tests pass together.
- [x] Production web and standalone plugin builds pass.
- [x] The installed-plugin smoke check passes without repository runtime imports or dependencies.
- [x] The Worker deployment dry run succeeds with D1, private R2, and Access configuration.
- [x] Git status and the final diff contain only intended feature and documentation changes, with no credentials, local state, generated deployment output, or ignored metadata.

Acceptance evidence: on August 30, 2026, `npm run format`, all workspace type checks, 259 tests, production web and plugin builds, all installed-plugin smoke modes, and `npm run deploy:dry-run` passed. The Cloudflare account API independently confirmed one self-hosted Access application for only `/inventory` and `/api/inventory*`, with one Allow policy for the configured owner email; its audience matches Worker configuration and its issuer matches the account's Access organization domain. Final status, diff, and credential-pattern checks found only intended tracked changes and deliberate test fixtures; generated deployment output remains ignored.
