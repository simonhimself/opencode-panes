# Simple Library Verification

Verified September 5, 2026 on `feat/simple-artifact-library`, using Node.js
22.23.2 and npm 11.14.1. This is local verification, not a deployment report.
This record describes the implementation before release. For the v0.3 rollout,
see the [GitHub release](https://github.com/simonhimself/opencode-panes/releases/tag/v0.3).

## Automated checks

- Formatting and TypeScript checks pass across the workspace.
- 174 tests pass: 39 Worker, 31 client, 35 shared-contract, and 69 plugin/installer tests.
- Production web and standalone plugin builds pass.
- The standalone plugin smoke check runs an upload from outside the repository
  without runtime dependencies or a global OpenCode installation.
- The Cloudflare deployment dry-run passes; it does not upload or deploy anything.
- Dependency installation reports zero known vulnerabilities.
- `git diff --check` passes. User-owned `artifacts/` source files are intentionally
  excluded from formatting, and their content is untouched.

## Local end-to-end checks

`scripts/acceptance-library.mjs` runs the built OpenCode plugin against the real
local Worker with isolated local D1 and R2 state. It has been run repeatedly
against the same local database. Every run uses a fresh temporary source identity.

Verified private upload, identical retry, exact source and binary bytes,
relative module assets and anonymous read-only CORS, no-expiry and finite shares,
private new versions, stable-link updates, old-version rejection, revocation,
new links after republishing, and deletion without changing local files.

## Browser checks

Checked the actual production build in Chromium, not a mocked UI:

- Project navigation and artifact opening from the library.
- HTML/CSS/SVG and JavaScript-built previews, including gallery thumbnails.
- Interactive module execution inside the isolated preview.
- Explicit publish confirmation, seven-day expiry display, and clipboard copy.
- Public viewing in a separate browser context without an owner session.
- Unpublishing through the dashboard and rejection of the old public link.
- Mobile layout at 390 px without horizontal page overflow.
- Light appearance even when the browser prefers dark mode.
- A guest script attempting parent-DOM access is blocked; its origin is opaque
  and its URL contains only a read-only preview capability, not an upload key.
- Mobile Lighthouse snapshot: accessibility 100 and best practices 100. These
  automated scores do not replace manual accessibility or cross-browser testing.

Review also covered upload/commit/delete races, source changes during collection,
transient Git identity failures, stale detail updates, and the distinction between
the latest uploaded version and the version currently shared.

## Release boundary

No Cloudflare deployment, remote migration, secret change, package publication,
commit, push, or real global plugin installation was performed. The live service
and the plugin loaded in the current OpenCode session remain unchanged.

Deployment needs the new `PANES_UPLOAD_KEY`, migration `0011_simple_library.sql`,
and Access coverage for `/inventory*` and `/api/library*`. Installation then
requires restarting OpenCode. Old remote data is not automatically deleted or
imported into the new library.

Uncommitted upload sessions are retained for retry; there is not an automatic
abandoned-upload expiry policy. Browser sandboxing does not eliminate every
resource-exhaustion risk. These are explicit operational limits, not promises
of multi-tenant hosting or arbitrary untrusted server execution.
