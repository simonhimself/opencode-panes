# OpenCode Panes Project Plan

## Accepted direction

This document supersedes the earlier remote-first, source-string plan. The old
`POST /api/artifacts` and source-string revision or Publication workflow is
historical compatibility only. Its mutation routes return
`410 LOCAL_FIRST_REQUIRED`. New implementation and usage must follow the
local-first plan below.

OpenCode Panes is a browser-side artifact workspace with immutable local
Revisions and an optional private cloud copy. It is not a chat application,
deployment platform, project builder, collaboration suite, backend host, or
general-purpose server runtime.

## Product promise

> Ask OpenCode to make an artifact. Review it locally, revise it locally, Sync
> deliberately, and Publish only after a human chooses what to share.

The project filesystem is canonical. Cloudflare is an optional synchronized
copy and sharing surface.

## Canonical local workflow

1. `artifact_prepare` creates a project-local Artifact and writable Draft with
   no network access.
2. OpenCode's normal filesystem tools create or import complete Draft files.
3. `artifact_finalize` validates one Preview entry, runs a local preview, and
   promotes the Draft to the next immutable contiguous `vN` Revision.
4. The creator reviews the Revision-specific loopback Local preview and source.
5. A new request prepares the next Draft from the latest Revision. Existing
   Drafts require an explicit resume or discard choice.
6. `artifact_sync` is called explicitly when a private cloud copy or link is
   needed. It uploads every unsynced finalized Revision in order.
7. Sync returns the Cloud inventory URL and a Creator URL when one is available,
   but does not Publish. Owner recovery requires an explicit later Creator-link
   rotation before a new Creator URL is available.
8. For a publish request, Sync completes first and may open Creator access. The
   human selects exactly one synced Revision and a 1-, 7-, or 30-day duration in
   Creator. The Creator viewer submits the Publication.

The canonical layout is:

```text
<git-worktree>/artifacts/<slug>/
  artifact.json
  .panesignore       # optional
  draft/
  draft.json
  v1/
  v2/
```

Without Git, the root is `<session-directory>/artifacts/`. A normalized
`remote.origin.url` supplies project identity when available. Otherwise
`artifacts/.panes-project.json` supplies a generated identity. Panes never
merges slug collisions and never uses the directory name as cloud identity.

`artifact.json` is the local non-secret Revision ledger. It includes all local
files, including files excluded from Sync, and persists approved origins. It
contains no credentials, bearer tokens, reconnect codes, or admission secrets.
Panes does not stage, commit, branch, revert, or rewrite Git state.

## Draft, Revision, and import contract

- Drafts are temporary and writable. Preparing a next Draft copies the latest
  finalized Revision. Drafts are never uploaded.
- Finalized Revisions are immutable by workflow, contiguous, and stored as
  `v1`, `v2`, and so on. Hash, size, path, or manifest changes block preview
  and Sync. A Git restore or explicit new Draft can recover the workflow.
- Finalization uses a recoverable journal and promotion sequence. It returns a
  Local preview URL only after the Revision is promoted.
- `artifact_import` stages a file or directory, preserves exact bytes, nested
  files, empty directories, and portable modes, and rejects unsafe paths and
  symlinks. It never deletes a source during ordinary import.
- A source-path import returns a five-minute verification receipt bound to the
  source snapshot, source path, import operation, and destination Artifact. The
  receipt is valid for five minutes. Only a separate Import call with explicit
  confirmation can delete it. Panes
  re-hashes immediately before deletion and leaves the source untouched when
  the receipt is expired or the source changed.

## Preview adapters and runtime policy

Each Revision declares one normalized relative Preview entry and adapter:

| Adapter | Supported entry |
| --- | --- |
| `browser` | HTML, SVG, or browser-built output served directly |
| `renderer` | React, Markdown, Mermaid, or code source wrapped at request time |

Stored source bytes are never transformed for the renderer wrapper. Framework
source is allowed, but an unsupported framework must be built locally into a
browser entry before Finalize. Panes does not run a framework server, backend,
database, container, or cloud build.

Local preview and cloud delivery share sandbox, CSP, MIME, routing, and network
policy. The local server binds only to IPv4 loopback and returns temporary
process-local URLs. Preview path traversal, aliases, escaping symlinks, and
changed finalized files are rejected.

HTTPS stylesheets, fonts, images, media, scripts, and API calls work by default
without origin approval. The advanced compatibility path accepts exact
normalized plain-HTTP origins and requires Finalize approval. Approved origins
are immutable per Revision and become derived CSP directives. `ws:`, `wss:`,
and all other schemes are unsupported; WebSockets are not available.

## Synchronization and storage

Sync is explicit and is the only new cloud creation path. Create, import,
Finalize, Local preview, and revision do not contact Cloudflare. First Sync
uses a stable idempotency key, creates the cloud identity, stores the Owner
credential in protected plugin state, records only the non-secret cloud mapping
in `artifact.json`, and then uploads unsynced Revisions in local version order.
Interrupted Sync uses local checkpoints and server leases to resume without
renumbering or duplicating a cloud Artifact. A multi-Revision Sync may commit
earlier Revisions before a later one fails.

R2 stores exact selected file bytes and non-secret cloud manifests. D1 stores
relational metadata, hashes, lifecycle state, and inventory data. New Revisions
do not store source-text bodies in D1. Temporary uncommitted upload objects are
eligible for scheduled cleanup after a 24-hour grace period; committed objects
are protected from that cleanup.

The local manifest can contain more files than the cloud copy. Before upload,
Panes applies an optional Artifact-root `.panesignore` using ordered
Gitignore-style rules and negation. Mandatory exclusions cannot be re-included:

- `.panesignore`, `artifact.json`, `draft/`, and `draft.json`;
- Git internals, dependency directories, and local build caches;
- `.env` files and common `.pem`, `.key`, and `.p12` files.

Panes derives a separate filtered cloud manifest containing only synchronized
Revisions, Preview entries, approved origins, and exact selected files. Ignored
filenames, paths, hashes, and sizes never appear in it. The cloud manifest
cannot be ignored, and neither it nor the canonical local manifest is uploaded
as Revision content. Public and Creator
delivery is mediated by the Worker from private R2. The R2 bucket is never
public.

Initial remote limits are 25 MiB per file and 100 MiB per Revision, measured in
raw bytes after ignore evaluation. They do not constrain local Drafts or local
Revision history. Legacy compatibility retains a separate 1 MiB UTF-8 source
limit.

## Credentials, lifecycle, and access

Panes keeps capabilities separate:

- The Owner credential authorizes Sync and Creator-link rotation for one cloud
  Artifact. It persists in protected local plugin state until replaced or
  locally removed. Cloud deletion invalidates it server-side but cannot remove
  the protected local state file. It is never in a URL, manifest, log, or tool
  result.
- A Creator link is one active private bearer capability with a fixed 30-day
  expiry. It reads all synced Revisions and manages Publication, but cannot
  delete cloud data or access inventory. Reusing it does not extend it;
  rotation revokes it and starts a new 30-day period.
- A Publication grants public access to exactly one synced Revision for 1, 7,
  or 30 days. Seven days is the default, permanent Publication is unavailable,
  and there is at most one active Publication per Artifact. Sharing a newer
  synced Revision through an active Publication preserves its Public URL and
  expiry. Expired and revoked Publication records remain server-side. Creator
  exposes the full history; inventory reports the current or latest state.
  Private synced files remain until explicit cloud deletion.
- A Public link is the bearer URL for that Publication. It cannot expose another
  private Revision unless the active Publication is explicitly updated to
  select it. Active Public tokens use a one-way lookup hash plus recoverable
  encrypted ciphertext under a versioned Worker-managed key. A
  Creator-authorized sharing response and the Access-protected inventory can
  reconstruct an active Public URL. Public token plaintext appears only in
  those authorized active-link results; encryption keys never leave Worker
  secret storage. Neither enters manifests, logs, or analytics. Revocation
  clears recoverable ciphertext immediately; expiry clears it when an
  inventory, Creator, or Public request observes the expired record.
- Cloud inventory is an Access-protected administrative surface for synced
  Artifacts. It shows current Artifacts before collapsed Legacy history and
  places recovery and destructive controls behind Manage. It groups current
  work by project and shows revision count, storage size, last Sync, Creator
  expiry, and Publication state. It has no knowledge of local-only Artifacts.
  Its Access session policy is separate from capability expiry; synced cloud
  data remains until explicit deletion.

Cloud deletion requires exact human confirmation in inventory. It revokes all
active Creator and Public capabilities, removes D1 metadata and private R2
objects in resumable batches when no longer referenced, and never modifies
local project files.

Owner recovery starts in Access-protected inventory. It issues a hashed,
single-use reconnect code valid for 10 minutes; issuing a newer code revokes an
older unused code. `artifact_reconnect` validates the local canonical manifest
and synchronized Revision metadata before redeeming the code. Recovery replaces
only the Owner credential, leaves Creator access and Publication unchanged, and
writes the replacement to protected local state.

The optional `PANES_CREATE_API_KEY` authorizes only first-Sync cloud-Artifact
creation. It is not a generic artifact credential and is not stored in local
Artifact state.

## Legacy migration

Existing remote-first source-string Artifacts are classified as Legacy. They
remain readable but read-only during a bounded migration window and appear in
a separate inventory grouping. One stable migration timestamp gives Legacy
private access 30 days and Legacy public links 7 days. Rerunning migration
never extends those deadlines.

Authenticated inventory export issues an adoption code for the current Legacy
Revision. `artifact_adopt_legacy` copies unchanged source bytes into a new
project-local finalized `v1` with the matching Preview adapter. The code is
short-lived, bound to one local destination, and retry-safe only for that same
binding. Adoption stores no Owner credential. The original Legacy Artifact and
history remain separate and read-only until explicit inventory deletion.

The first later Sync creates a new cloud identity and records Legacy provenance.
The old source-string create, revise, and Publication mutations are not a new
workflow and return `410 LOCAL_FIRST_REQUIRED`.

## Plugin contract

The installed plugin registers these local-first and compatibility tools:

```text
artifact_prepare
artifact_import
artifact_finalize
artifact_sync
artifact_publish
artifact_adopt_legacy
artifact_reconnect
artifact_discover
artifact_reopen
```

`artifact_sync.openCreatorAfterSuccess` defaults to false. Setting it true
requests the separate browser-open permission only after successful Sync and
still returns an available URL if opening fails. After Owner recovery, explicit
Creator-link rotation is required before a URL is available.
`artifact_publish` never selects a Revision or duration and never submits a
Publication. The installed plugin is sufficient; no Panes skill, slash command,
package publication, backend hosting, or automatic Git action is required.

## Scope status

- [x] Project-local Artifact, Draft, immutable Revision, discovery, reopen, and
  recoverable finalization.
- [x] File and directory import with raw-byte preservation and verification
  receipts.
- [x] Browser and renderer Preview adapters with approved-origin security.
- [x] Explicit private Sync, filtered cloud manifests, private R2, limits,
  resumable upload, and Owner state recovery.
- [x] Creator links, human-controlled Publication, selected-Revision public
  isolation, encrypted recoverable active Public tokens, and inventory actions.
- [x] Legacy read-only migration, bounded expiry, inventory export and adoption,
  and new cloud identity after adoption.
- [x] Private local plugin build and installation with no registry publication.
- [ ] Rate limiting and broader cross-browser hostile-artifact testing remain
  validation work. Primary and additional-provider OpenCode acceptance is
  complete; only the time-gated natural Publication-expiry observation remains.

The repository's local checks cover the implemented contracts. Deployment or a
hosted test service does not imply production readiness.
