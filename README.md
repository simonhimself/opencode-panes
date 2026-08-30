# OpenCode Panes

OpenCode Panes is a local-first artifact workspace for OpenCode. The project
filesystem is canonical. Panes adds browser previews, immutable local
Revisions, and an optional private cloud copy for sharing. It is not a
deployment platform or a backend host.

## The local model

Panes uses this layout under the current project:

```text
<git-worktree>/artifacts/
  <slug>/
    artifact.json
    .panesignore                 # optional
    draft/
    draft.json
    v1/
    v2/
```

When the session is not in a Git worktree, the root is
`<session-directory>/artifacts/`. A normalized `remote.origin.url` is the
project identity when it is available. Otherwise Panes creates or reads
`artifacts/.panes-project.json`; the directory name is only display metadata.
Panes never merges slug collisions implicitly.

`artifact.json` is the canonical, non-secret local manifest. It records the
artifact identity, title, kind, every finalized Revision, Preview metadata,
file paths, hashes, byte sizes, media types, and approved HTTP(S) origins. It
never contains Owner credentials, Creator or Public tokens, reconnect codes,
or admission keys.

`artifact_prepare` creates an Artifact and writable Draft without network
access. A later Draft starts from the latest finalized Revision. OpenCode's
normal filesystem tools can create or change any Draft files. Existing Drafts
must be explicitly resumed or discarded. `artifact_finalize` validates one
Preview entry, probes it locally, and promotes the Draft to the next immutable
`vN` Revision. A changed finalized Revision blocks preview and Sync instead of
being silently repaired.

## Preview and import

Every finalized Revision declares one Preview adapter:

- `browser` serves an HTML, SVG, or browser-built entry directly.
- `renderer` wraps supported React, Markdown, Mermaid, or code source at
  request time. Stored source bytes are not rewritten.

Framework source is fine, but unsupported frameworks must be built locally
into a browser entry before finalization. Panes does not run framework servers,
backend code, databases, or containers.

Finalize and Local preview do not contact Cloudflare. The returned preview is a
temporary, unguessable `http://127.0.0.1` URL for one Revision. It is
process-local and is not a durable Creator link. Prepare or reopen can issue a
new local URL after a restart.

`artifact_import` copies a file or directory through temporary staging into a
Draft, preserving raw bytes, nested files, empty directories, and portable
modes. It rejects unsafe paths and symlinks. Ordinary import does not delete
the source. A source-path import returns a five-minute verification receipt.
Only a separate Import call with the same `sourcePath`, the
`verificationReceipt`, `deleteSource: true`, and `confirmDeletion: true` can
remove the source. Panes re-hashes the source first and leaves it untouched if
the receipt expired or the source changed.

## Sync and Publication

Sync is explicit. Create, import, finalize, Local preview, and revision do not
upload anything. `artifact_sync` uploads every unsynced finalized Revision in
order, asks permission before the first cloud upload, and returns the Cloud
inventory URL plus a Creator URL when one is available. After Owner recovery,
Creator access stays unavailable until an explicit link rotation. Sync is
private and never publishes an artifact.

`openCreatorAfterSuccess` defaults to `false`. When true, successful Sync asks
for the separate browser-open permission after Sync completes. It still returns
the validated Creator URL if opening is denied or fails. A natural-language
publish request only runs Sync and opens or returns Creator access. The human
then selects exactly one synced Revision and confirms Share for 1, 7, or 30
days in the Creator workspace. Seven days is the default. Confirmed Share
immediately returns Copy link and Open link actions. Permanent Publication is
not available.

Only the selected Revision and its selected files are public. Sharing a newer
Revision through an active Publication preserves its Public URL and expiry.
Expired, revoked, or explicitly rotated shares receive a new Public URL.
Extension and unpublish remain explicit actions. Non-secret Publication records
remain server-side. Creator exposes the full history, while inventory reports
the current or latest state. Private synced files remain until explicit cloud
deletion.

## Credentials and access

These capabilities are intentionally separate:

| Capability       | Purpose                                                                     | Lifetime and boundary                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner credential | Sync and Creator-link rotation for one cloud Artifact                       | Persistent in protected local plugin state. Replaced on recovery or rotation, never put in a URL or repository.                                                                        |
| Creator link     | View and manage one private synced Artifact, including Publication actions  | One active bearer link, fixed 30-day expiry. It cannot delete cloud data or open inventory.                                                                                            |
| Publication      | Server-side record granting public access to one selected synced Revision   | 1, 7, or 30 days. One active Publication per Artifact; its selected Revision may update without changing its URL or expiry. Records remain server-side.                                |
| Public link      | Bearer URL for its active Publication                                       | Expires with the Publication and exposes only its currently selected Revision. Its token is separate from the Publication record.                                                      |
| Cloud inventory  | List and administer synced cloud Artifacts, including deletion and recovery | Access-protected administrative surface. Access session policy is separate from capability expiry; synced data remains until explicit deletion. It does not list local-only Artifacts. |

The inventory is protected by Cloudflare Access and its configured approved
identity. Creator and Public routes use their own scoped capabilities and are
not Access login routes. The active Public token is stored server-side as a
one-way lookup hash plus recoverable encrypted ciphertext under a versioned
Worker-managed key. A Creator-authorized sharing response and the
Access-protected inventory can reconstruct an active Public URL. Public-token
plaintext appears only in those authorized active-link results. Encryption keys
never leave Worker secret storage. Neither value appears in manifests, logs, or
analytics. Trusted plugin flows separately receive the scoped Owner or Creator
credential they are designed to persist.
Revocation clears recoverable Public-token ciphertext immediately; expiry
clears it when an inventory, Creator, or Public request observes the expired
record.

The first Sync may require `PANES_CREATE_API_KEY`. This is only an admission
key for creating a new cloud Artifact, not a general artifact credential. The
plugin sends it only on first Sync and does not store it in local artifact
state.

## Cloud boundaries and limits

The canonical local manifest can contain more than the cloud copy. Before
Sync, Panes applies `.panesignore` from the Artifact root using ordered
Gitignore-style rules, including negation. Mandatory exclusions cannot be
re-included. These include `.panesignore`, `artifact.json`, Draft files and
directories, Git internals, dependency directories, build caches, environment
files, and common key or certificate files. Excluded files do not count toward
remote limits, and neither `.panesignore` nor the canonical manifest is
uploaded.

Panes derives a separate non-secret cloud manifest containing only synchronized
Revisions, approved origins, Preview entries, and the exact selected files.
Ignored filenames, paths, hashes, and sizes never appear in that manifest. The
cloud manifest itself cannot be ignored. Exact selected file bytes are stored
in private R2 and are served only through Worker authorization; the R2 bucket
is never public.

Initial remote limits are 25 MiB per uploaded file and 100 MiB per uploaded
Revision, measured from raw bytes after ignore evaluation. These limits do not
limit local Drafts or local Revision history. The historical Legacy source
compatibility path retains its separate 1 MiB UTF-8 source limit.

HTTPS stylesheets, fonts, images, media, scripts, and API calls work by default
without origin approval. The advanced compatibility path accepts exact
normalized plain-HTTP origins and requires the existing approval handshake.
Approved origins are immutable on that Revision. Panes derives the relevant CSP
rules from this policy. `ws:`, `wss:`, and all other schemes are unsupported,
even when the corresponding HTTP origin is approved. WebSockets are not
available.

Cloud deletion is an explicit, exact-confirmation action in the Access-protected
inventory. It revokes Creator and Public access, removes cloud metadata and
private R2 objects in resumable batches, and never changes local files. A
temporary interrupted upload can be cleaned up after its grace period without
touching committed objects.

If protected Owner state is lost, the inventory can issue a short-lived,
single-use reconnect code after explicit confirmation. Codes are hashed at
rest, expire after 10 minutes, and a newer code revokes an older unused code.
`artifact_reconnect` validates the canonical local manifest before redeeming
the code, replaces only the Owner credential, and leaves Creator and Public
access unchanged. The replacement is written to protected local state.

## Installation

The installed private plugin is sufficient. No Panes skill, slash command,
package publication, backend hosting, or automatic Git operation is required.
Panes does not stage, commit, branch, revert, or rewrite Git state.

Requires Node.js 22.12 or newer and npm 11.

```sh
npm install
npm run build:plugin
npm run install:plugin
```

The installer writes `opencode-panes.js` and its `react-compiler.wasm` runtime
asset to the OpenCode plugin directory (or the directory selected by
`XDG_CONFIG_HOME`). OpenCode discovers the plugin automatically. A project-local plugin can instead be loaded from
`.opencode/plugins/`. Restart OpenCode after installation. The optional
`packages/opencode-plugin/commands/artifact.md` template is not required and
does not install or configure the plugin.

The hosted test service is `https://opencode-panes.simons.workers.dev`; users
do not need to host a backend. The plugin accepts an API origin override for
local development, and non-loopback HTTP origins are rejected.

## Legacy migration

Existing source-string cloud Artifacts remain readable but read-only during a
bounded migration window. A stable migration timestamp gives Legacy private
access 30 days and Legacy public links 7 days. Rerunning migration does not
extend either deadline. Legacy Artifacts appear separately in Cloud inventory.

From the authenticated inventory, export the current Legacy Revision and issue
an adoption code. `artifact_adopt_legacy` writes unchanged source bytes into a
new project-local finalized `v1` with the appropriate Preview adapter. The code
is short-lived, bound to one local destination, and safe to retry only for that
same binding. Adoption stores no Owner credential. The original Legacy
Artifact and history remain separate and read-only until explicitly deleted.

The first explicit Sync after adoption creates a new cloud identity and records
the Legacy provenance. The retired source-string create, revise, and publish
mutations return `410 LOCAL_FIRST_REQUIRED`; new work must use the local-first
workflow.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run smoke:plugin
```

See `CONTEXT.md` for the domain vocabulary, `PROJECT_PLAN.md` for the accepted
scope, and `packages/opencode-plugin/README.md` for plugin details.
