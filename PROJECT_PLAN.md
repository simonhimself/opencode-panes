# OpenCode Panes Project Plan

## Product Summary

OpenCode Panes brings a Claude Artifacts-style workflow to OpenCode.

The creator asks OpenCode to make an artifact. The plugin prepares a project-local Artifact and Draft, then explicitly Syncs a finalized Revision when a cloud link is needed. The creator can inspect and interact with the result, then continue prompting OpenCode to create new local revisions.

The product is an artifact renderer and lightweight revision store. It is not a chat application, deployment platform, project builder, or collaboration suite.

## Core Promise

> Ask OpenCode to make an artifact. It opens as a local working visual page. Keep prompting, finalize revisions, and Sync deliberately.

## Primary Workflow

1. The creator asks OpenCode to create an artifact, prototype, diagram, document, or visual explanation.
2. OpenCode calls `artifact_prepare` or `artifact_import`.
3. The plugin creates a project-local Artifact and writable Draft without network access.
4. OpenCode writes or imports complete files into the Draft.
5. OpenCode calls `artifact_finalize` to record an immutable local Revision and open a local preview.
6. The creator reviews the local preview and source.
7. The creator asks OpenCode to revise the artifact, and OpenCode prepares the next Draft.
8. The creator explicitly calls `artifact_sync` when a cloud identity or link is needed.
9. Sync stores every unsynced immutable Revision in order and returns Creator or public lifecycle links.
10. The creator can copy or download a selected Revision and manage publication from Inventory.

Legacy adoption is an explicit inventory-to-plugin handoff. The creator issues a
short-lived adoption code for the current Legacy Revision, then the
plugin redeems it into a project-local finalized v1 without changing source
bytes. The original Legacy history stays separate and read-only. The first
local-first Sync creates a new cloud identity and records the Legacy provenance.

Legacy compatibility is bounded. The retired source-string mutation routes return
`410 LOCAL_FIRST_REQUIRED` without parsing, authenticating, looking up, or
mutating an artifact. Legacy reads, sharing, adoption export, and explicit cloud
deletion remain available through their migration windows. New iteration uses the
local-first workflow above.

## MVP Scope

### Artifact Types

- [x] Single-file HTML
- [x] Single React component
- [x] SVG
- [x] Mermaid
- [x] Markdown
- [x] Source code

### Creator Experience

- [x] Private artifact URL
- [x] Rendered preview
- [x] Preview and Code toggle
- [x] Artifact title and type
- [x] Version selector
- [x] Automatic refresh while OpenCode creates a new revision
- [x] Copy source
- [x] Download source
- [x] Publish a selected revision
- [x] Read-only public artifact page
- [x] Mobile-friendly public viewer
- [x] Isolate public publications to one selected Revision and mediated files
- [x] Runtime error display
- [x] Copy error details for use in an OpenCode follow-up prompt
- [x] Stop or reload a misbehaving preview

### OpenCode Integration

- [x] Install the OpenCode server plugin as a private local plugin file
- [x] Register the local-first `artifact_prepare`, `artifact_import`, `artifact_finalize`, and `artifact_sync` tools
- [x] Register `artifact_adopt_legacy` and `artifact_reconnect` compatibility tools
- [x] Register the local-first `artifact_reconnect` tool for Owner credential recovery
- [x] Associate artifacts with the current OpenCode session ID
- [x] Return artifact ID, revision, and browser URL in the tool result
- [x] Request permission before uploading source for the first time
- [x] Provide an optional `/artifact` command
- [x] Provide an optional browser auto-open setting
- [x] Document project and global installation
- [x] Bundle and install a global plugin file with no repository dependency
- [x] Recover a lost Owner credential with an authenticated, short-lived, single-use reconnect code
- [x] Adopt a Legacy Revision into a project-local finalized v1 with retry-safe provenance

## OpenCode Plugin Contract

The plugin registers the local-first preparation, import, finalization, Sync, and compatibility tools:

```ts
artifact_prepare({
  artifactId?: string,
  title?: string,
  slug?: string,
  kind?: string,
  requestedOrigins?: string[],
  draftAction?: "resume" | "discard",
  idempotencyKey?: string,
})

artifact_finalize({
  artifactId: string,
  entryPath: string,
  adapter: "browser" | "renderer",
  renderer?: "react" | "markdown" | "mermaid" | "code",
})

artifact_sync({
  artifactId: string,
  openCreatorAfterSuccess?: boolean,
  rotateCreatorLink?: boolean,
})
```

Behavior:

- `artifact_prepare` or `artifact_import` creates local state and never contacts Cloudflare.
- `artifact_finalize` records a local immutable Revision and returns a local preview URL.
- `artifact_sync` is the only new cloud creation path and uploads every unsynced finalized Revision in order, including only the files selected by the local ignore rules.
- `artifact_sync.openCreatorAfterSuccess` defaults to `false`. When `true`, successful Sync requests opening the validated Creator URL through the separate `artifact_open` permission; Sync still returns the URL if opening is denied or fails.
- The OpenCode `sessionID` is recorded in Sync metadata when available.
- Adoption writes an unchanged local finalized v1; its first Sync creates a new cloud identity.
- The source is not repeated in the tool result.

The local-first `artifact_prepare` tool creates a project-local `artifact.json` and writable `draft/` under the Git worktree's `artifacts/` directory, or under the session directory when Git is unavailable. The `artifact_finalize` tool validates a declared Preview entry, promotes the Draft to the next immutable `vN`, records raw file metadata, and returns a temporary loopback Local preview URL. Neither tool contacts Cloudflare or modifies Git state.

Initial tool guidance:

> Use this tool when the user requests an artifact, prototype, interactive design, diagram, visual explanation, substantial document, or standalone code preview. Prefer an artifact when the result is easier to understand visually than as terminal text.

## User Interface

The browser viewer is a compact artifact workspace, not a separate chat application.

### Creator View

- Header with title, version, copy, download, and publish actions
- Preview and Code tabs
- Full-height artifact canvas
- Build or runtime error state
- New-revision polling while the page is open

### Public View

- Read-only selected revision
- Preview and Code tabs
- Copy source and copy link actions
- User-generated content notice
- Responsive full-screen canvas

## Rendering Model

All artifact rendering happens in the browser.

| Artifact type | Initial renderer |
| --- | --- |
| HTML | Sandboxed `srcdoc` iframe |
| React | `esbuild-wasm` in a Web Worker, executed in a sandboxed iframe |
| SVG | Sanitized SVG rendered in an isolated iframe |
| Mermaid | Mermaid with strict security mode |
| Markdown | `react-markdown` with raw HTML disabled |
| Code | Syntax-highlighted source view |

React version one is intentionally constrained:

- One JSX or TSX component
- Fixed React and ReactDOM runtime
- Fixed allowlist of supported libraries
- No arbitrary npm installation
- No server-side code
- No arbitrary network access

Candidate built-in libraries:

- React and ReactDOM
- Lucide icons
- Recharts
- D3
- Framer Motion
- A small utility CSS bundle

The final allowlist should stay small until real artifacts demonstrate a need for more.

## Cloudflare Architecture

The MVP uses one Workers project:

```text
OpenCode plugin
      |
      v
Cloudflare Worker API
      |
      +-- D1 artifact metadata and source revisions
      +-- Workers Static Assets artifact viewer
```

### Worker API

Planned and retained routes:

```text
POST /api/artifacts                         # Legacy mutation contract, returns 410
POST /api/artifacts/:id/revisions           # Legacy mutation contract, returns 410
GET  /api/artifacts/:id
GET  /api/artifacts/:id/revisions
POST /api/artifacts/:id/publish             # Legacy mutation contract, returns 410
POST /api/artifacts/:id/unpublish           # Legacy mutation contract, returns 410
GET  /api/public/:shareToken
POST /api/sync/artifacts
POST /api/sync/artifacts/:id/revisions/:version/commit
```

### D1 Data Model

`artifacts`

```text
id
owner_token_hash
opencode_session_id
title
type
current_revision_id
created_at
updated_at
```

`revisions`

```text
id
artifact_id
version
source
created_at
```

`shares`

```text
token_hash
artifact_id
revision_id
created_at
revoked_at
```

Initial remote source limits: 25 MB per file and 100 MB per Revision. Historical Legacy source compatibility remains capped at 1 MB.

## Security Requirements

Generated code is untrusted.

- [x] Render executable artifacts in an iframe with `sandbox="allow-scripts"`
- [x] Never add `allow-same-origin`
- [x] Set `referrerpolicy="no-referrer"`
- [x] Block external subresource egress by default with parent and iframe CSPs
- [x] Block nested frames, objects, forms, popups, and top navigation
- [x] Prevent artifact code from accessing Panes cookies, DOM, or storage
- [x] Render Markdown without raw HTML
- [x] Sanitize SVG before rendering
- [x] Use Mermaid strict security mode
- [x] Compile React in a terminateable Web Worker with source and time limits
- [x] Provide reload and stop controls for responsive previews
- [x] Generate tokens with Web Crypto
- [x] Store hashes of owner and share tokens, not plaintext tokens
- [x] Keep private and public URLs separate
- [x] Never log artifact source or private tokens by default

Initial iframe CSP:

```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data:;
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

## Explicit Non-Goals

- Built-in chat or model selection
- Claude, OpenAI, or Workers AI calls from inside artifacts
- MCP Apps support
- Git repositories or Cloudflare Artifacts storage
- Multi-file projects
- Arbitrary npm dependencies
- Vite or server-side build jobs
- Cloudflare Sandbox SDK
- Workers for Platforms
- Queues, Workflows, or Durable Objects
- R2 storage unless source-size evidence requires it
- Full-stack applications
- Artifact-owned databases or persistent app state
- Team collaboration, comments, or approvals
- Community gallery or marketplace
- Native OpenCode desktop or web UI modifications
- A custom OpenCode message-part type

## Milestones

### Milestone 0: Foundation

- [x] Choose package names and repository layout
- [x] Create the Workers application
- [x] Create the OpenCode plugin package
- [x] Configure TypeScript, formatting, tests, and CI
- [x] Add local development instructions
- [ ] Record architectural decisions in short ADRs

Exit criteria:

- The Worker and plugin run locally.
- CI validates both packages.

### Milestone 1: HTML Vertical Slice

- [x] Create D1 migrations for artifacts and revisions
- [x] Implement initial source-string artifact API (historical, superseded by Ticket 20; mutation routes now return 410)
- [x] Implement initial source-string revision API (historical, superseded by Ticket 20; mutation routes now return 410)
- [x] Implement private artifact retrieval
- [x] Build the minimal artifact viewer
- [x] Render HTML in a restricted iframe
- [x] Add Preview and Code tabs
- [x] Register the initial OpenCode `artifact` tool (historical, removed by Ticket 20)
- [ ] Return a working private URL from an OpenCode conversation

Exit criteria:

- Asking OpenCode for an HTML artifact produces a working browser preview.
- Asking for a revision updates the same artifact and preserves version one.

### Milestone 2: Artifact Parity

- [x] Add React rendering
- [x] Add SVG rendering
- [x] Add Mermaid rendering
- [x] Add Markdown rendering
- [x] Add dependency-free source syntax highlighting
- [x] Add version selection
- [x] Add copy and download
- [x] Add creator-view polling
- [x] Add runtime error capture
- [x] Add reload and stop controls

Exit criteria:

- Every MVP artifact type can be created and revised through OpenCode.
- Previous versions remain selectable.

### Milestone 3: Publishing

- [x] Add selected-revision publishing (current lifecycle is managed from Inventory after explicit Sync)
- [x] Add share-token generation and hashing
- [x] Add public artifact route
- [x] Add unpublish and revocation
- [x] Add public user-generated content notice
- [x] Add responsive public viewer
- [x] Verify private revisions cannot be accessed from public links

Exit criteria:

- A creator can publish one immutable revision and share it without exposing the private workspace or later revisions.

### Milestone 4: Private OpenCode Installation

- [x] Add first-Sync upload permission flow
- [x] Add optional `/artifact` command
- [x] Add optional browser auto-open
- [x] Document project-scoped installation
- [x] Document global installation
- [x] Install the plugin as an auto-discovered global plugin file
- [x] Add a repository-independent global plugin build and installer
- [ ] Test with multiple OpenCode-supported model providers
- [x] Refine local-first tool guidance based on model behavior

Exit criteria:

- The private operator can load the built plugin from OpenCode's local plugin directory and create an artifact using the documented steps.

### Milestone 5: Hardening

- [x] Add API and local file/revision-size limits; retain the old source limit only for Legacy adoption
- [ ] Add rate limiting
- [x] Add iframe sandbox and CSP regression tests
- [x] Add malicious HTML, SVG, Markdown, and React test cases
- [x] Add revision authorization tests
- [x] Add public-share revocation tests
- [ ] Add mobile and desktop browser tests
- [x] Add structured Worker logging without source contents
- [x] Deploy a production instance on Cloudflare

Exit criteria:

- Security tests cover each executable or sanitizable artifact type.
- The hosted test service supports the documented private local-plugin workflow.

## MVP Release Status

- [x] Local implementation, automated tests, builds, built-plugin smoke check, audit, and generated-config deploy dry-run pass
- [x] MIT licensing, local release documentation, optional command template, and no-secret CI workflow are present
- [x] Keep the plugin private and install it as an auto-discovered local plugin file
- [x] Create and migrate a production D1 database
- [x] Deploy the Worker and viewer to production
- [ ] Run real cross-browser hostile-artifact and infinite-loop testing
- [ ] Complete a real OpenCode conversation acceptance test across supported model providers

Deployment does not imply production readiness. Rate limiting, real host/provider acceptance, and cross-browser hostile testing remain open. The plugin is intentionally private and local-only; registry publication and external-user release validation are not project goals.

## MVP Acceptance Test

The MVP is complete when this workflow succeeds:

1. Install the Panes plugin in OpenCode.
2. Start an OpenCode session.
3. Ask: `Create an artifact showing a clickable SaaS onboarding flow.`
4. OpenCode calls `artifact_prepare` and writes complete files into the Draft.
5. OpenCode calls `artifact_finalize` and opens the local preview.
6. The preview shows the working interactive artifact and its source.
7. Ask: `Make the second step optional and use a darker visual style.`
8. OpenCode prepares and finalizes version two locally.
9. The local preview detects version two.
10. Both versions remain selectable.
11. Explicitly Sync version two when a cloud link is needed.
12. Open the returned Creator or public URL in a private browser session.
13. The artifact works without exposing local credentials or unpublished revisions.

## Later Decisions

These require usage evidence before implementation:

- Authentication beyond private owner tokens
- Larger source and binary asset storage in R2
- More React libraries
- Persistent artifact storage
- AI calls from inside artifacts
- MCP integrations
- Native OpenCode artifact panes if OpenCode adds a supported extension point
- Support for other coding agents

## References

### Claude Artifacts

- [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Publish and share artifacts](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts)
- [Creating with artifacts](https://academy.claude.com/courses/claude-101/creating-with-artifacts)

### OpenCode

- [Plugins](https://opencode.ai/docs/plugins/)
- [Custom tools](https://opencode.ai/docs/custom-tools/)
- [Server](https://opencode.ai/docs/server/)
- [SDK](https://opencode.ai/docs/sdk/)
- [TUI plugin specification](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/specs/tui-plugins.md)
- [Inline artifact rendering request](https://github.com/anomalyco/opencode/issues/25076)

### Cloudflare

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1](https://developers.cloudflare.com/d1/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## Progress Log

Add short dated entries here when a milestone changes state or a material product decision is made.

| Date | Update |
| --- | --- |
| 2026-08-17 | Initial creator-first plan recorded. Scope reduced to an OpenCode plugin, browser renderer, Worker API, and D1 revision storage. |
| 2026-08-18 | Completed the local-only MVP release pass: MIT licensing, CI, root build and generated-config deploy scripts, deployment instructions, safe lexical source highlighting, an optional `/artifact` command template, and a deterministic built-plugin registration smoke check. Local verification passed; production D1 and deployment, cross-browser hostile-loop testing, and real OpenCode/provider acceptance remained open. |
| 2026-08-18 | Deployed the protected test service to `opencode-panes.simons.workers.dev` with a production D1 database and required creation secret. Verified create, private read, revision, publish, public read, revocation, and response headers. |
| 2026-08-18 | Ran a real OpenCode live acceptance pass. Creation, owner-token revision, version polling, immutable public pinning, revocation, mobile layout, and all six renderers passed. Browser inspection found the parent CSP blocked `srcdoc` scripts; the deployed hotfix corrected the CSP intersection and added a regression test. The model also omitted the creator fragment in its final Markdown link despite the structured tool result being correct, so tool guidance now requires preserving `viewerUrl` exactly. Workers Logs were enabled after confirming prior log claims were not observable; the final query found 112 invocations and zero error events. |
| 2026-08-18 | Made plugin distribution explicitly private and local-only. Registry publication and external-user release validation were removed from scope; the supported installation is an auto-discovered OpenCode plugin file. |
| 2026-08-28 | Added a standalone bundled global plugin and atomic installer. The installed plugin no longer imports or depends on the source repository. |
