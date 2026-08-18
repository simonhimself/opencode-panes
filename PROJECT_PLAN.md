# OpenCode Panes Project Plan

## Product Summary

OpenCode Panes brings a Claude Artifacts-style workflow to OpenCode.

The creator asks OpenCode to make an artifact. An OpenCode plugin sends the generated source to a Cloudflare-hosted renderer and returns a browser URL. The creator can inspect and interact with the result, then continue prompting OpenCode to create new versions of the same artifact.

The product is an artifact renderer and lightweight revision store. It is not a chat application, deployment platform, project builder, or collaboration suite.

## Core Promise

> Ask OpenCode to make an artifact. It opens as a working visual page. Keep prompting, and it updates.

## Primary Workflow

1. The creator asks OpenCode to create an artifact, prototype, diagram, document, or visual explanation.
2. OpenCode calls the `artifact` tool registered by the Panes plugin.
3. The plugin sends the artifact source to the Panes API on Cloudflare.
4. The tool returns the private artifact URL and artifact ID.
5. The creator opens the URL in a browser tab or browser panel.
6. The page displays the rendered preview and underlying source.
7. The creator asks OpenCode to revise the artifact.
8. OpenCode calls the tool again with the existing artifact ID.
9. Panes stores an immutable revision and refreshes the creator view.
10. The creator can copy, download, or publish a selected revision.

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
- [x] Runtime error display
- [x] Copy error details for use in an OpenCode follow-up prompt
- [x] Stop or reload a misbehaving preview

### OpenCode Integration

- [ ] Publish an OpenCode server plugin as an npm package
- [x] Register one `artifact` custom tool
- [x] Associate artifacts with the current OpenCode session ID
- [x] Return artifact ID, revision, and browser URL in the tool result
- [x] Request permission before uploading source for the first time
- [x] Provide an optional `/artifact` command
- [x] Provide an optional browser auto-open setting
- [x] Document project and global installation

## OpenCode Plugin Contract

The plugin registers one tool:

```ts
artifact({
  artifactId?: string,
  title: string,
  type: "html" | "react" | "svg" | "mermaid" | "markdown" | "code",
  source: string,
})
```

Behavior:

- Omitting `artifactId` creates a new artifact.
- Providing `artifactId` creates a new immutable revision.
- The OpenCode `sessionID` is recorded automatically from tool context.
- The tool result contains the artifact ID, revision number, and private viewer URL.
- The source is not repeated in the tool result.

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

Planned routes:

```text
POST /api/artifacts
POST /api/artifacts/:id/revisions
GET  /api/artifacts/:id
GET  /api/artifacts/:id/revisions
POST /api/artifacts/:id/publish
POST /api/artifacts/:id/unpublish
GET  /api/public/:shareToken
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

Initial source size limit: 1 MB per revision.

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
- [x] Implement artifact creation API
- [x] Implement artifact revision API
- [x] Implement private artifact retrieval
- [x] Build the minimal artifact viewer
- [x] Render HTML in a restricted iframe
- [x] Add Preview and Code tabs
- [x] Register the OpenCode `artifact` tool
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

- [x] Add selected-revision publishing
- [x] Add share-token generation and hashing
- [x] Add public artifact route
- [x] Add unpublish and revocation
- [x] Add public user-generated content notice
- [x] Add responsive public viewer
- [x] Verify private revisions cannot be accessed from public links

Exit criteria:

- A creator can publish one immutable revision and share it without exposing the private workspace or later revisions.

### Milestone 4: OpenCode Distribution

- [x] Add first-upload permission flow
- [x] Add optional `/artifact` command
- [x] Add optional browser auto-open
- [x] Document project-scoped installation
- [x] Document global installation
- [ ] Package and publish the plugin
- [ ] Test with multiple OpenCode-supported model providers
- [ ] Refine tool guidance based on model behavior

Exit criteria:

- A new user can install the plugin and create an artifact from OpenCode using the documented steps.

### Milestone 5: Hardening

- [x] Add API and source-size limits
- [ ] Add rate limiting
- [x] Add iframe sandbox and CSP regression tests
- [x] Add malicious HTML, SVG, Markdown, and React test cases
- [x] Add revision authorization tests
- [x] Add public-share revocation tests
- [ ] Add mobile and desktop browser tests
- [x] Add structured Worker logging without source contents
- [ ] Deploy a production instance on Cloudflare

Exit criteria:

- Security tests cover each executable or sanitizable artifact type.
- The hosted service is ready for external users.

## Local MVP Release Status

- [x] Local implementation, automated tests, builds, plugin pack dry-run, built-plugin smoke check, audit, and generated-config deploy dry-run pass
- [x] MIT licensing, local release documentation, optional command template, and no-secret CI workflow are present
- [ ] Publish the plugin to npm or otherwise complete package distribution
- [ ] Create and migrate a production D1 database
- [ ] Deploy the Worker and viewer to production
- [ ] Run real cross-browser hostile-artifact and infinite-loop testing
- [ ] Complete a real OpenCode conversation acceptance test across supported model providers
- [ ] Validate the release with external users

Local completion does not imply production readiness. Production resources, deployment, publication, real host/provider acceptance, and external-user validation remain intentionally out of scope for this pass.

## MVP Acceptance Test

The MVP is complete when this workflow succeeds:

1. Install the Panes plugin in OpenCode.
2. Start an OpenCode session.
3. Ask: `Create an artifact showing a clickable SaaS onboarding flow.`
4. OpenCode calls the `artifact` tool without requiring source to be copied manually.
5. The tool returns a private browser URL.
6. The URL shows a working interactive preview and its code.
7. Ask: `Make the second step optional and use a darker visual style.`
8. OpenCode creates version two of the same artifact.
9. The open browser viewer detects version two.
10. Both versions remain selectable.
11. Publish version two.
12. Open the public URL in a private browser session.
13. The artifact works without exposing the owner URL, OpenCode session, or unpublished versions.

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
| 2026-08-18 | Completed the local-only MVP release pass: MIT licensing, CI, root build and generated-config deploy scripts, deployment instructions, safe lexical source highlighting, an optional `/artifact` command template, and a deterministic built-plugin registration smoke check. Local verification passed; npm publication, production D1 and deployment, cross-browser hostile-loop testing, real OpenCode/provider acceptance, and external-user release remain open. |
