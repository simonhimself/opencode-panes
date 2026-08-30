# @opencode-panes/plugin

The private local OpenCode plugin registers the local-first
`artifact_prepare`, `artifact_import`, `artifact_finalize`, `artifact_sync`,
`artifact_publish`, `artifact_adopt_legacy`, and `artifact_reconnect` tools,
plus `artifact_discover` and `artifact_reopen` for local artifact navigation.
The installed plugin is sufficient. No Panes skill, slash command, package
publication, backend hosting, or automatic Git action is required.

## Install

From the repository root:

```sh
npm install
npm run build:plugin
npm run install:plugin
```

The installer atomically writes `opencode-panes.js` and its
`react-compiler.wasm` runtime asset to the global OpenCode plugin directory.
OpenCode discovers the plugin automatically. For project-scoped development,
load `dist/index.js` from
`.opencode/plugins/opencode-panes.js`:

```js
import PanesPlugin from "file:///absolute/path/to/opencode-panes/packages/opencode-plugin/dist/index.js";

export const OpenCodePanesPlugin = async (context) =>
  PanesPlugin(context, {
    apiBaseUrl: "http://127.0.0.1:5173",
    requestTimeoutMs: 15000,
  });
```

Restart OpenCode after changing plugins. The optional `/artifact` command
template can be copied manually, but it is not required and does not install
or configure the plugin.

The bundled global entry defaults to
`https://opencode-panes.simons.workers.dev`. `apiBaseUrl` and
`OPENCODE_PANES_API_BASE_URL` can override it. Non-loopback HTTP origins are
rejected. The optional first-Sync admission key can come from
`OPENCODE_PANES_CREATE_API_KEY` or the protected config-directory secrets file
`secrets/opencode-panes-create-key`. It is sent only when first Sync creates a
cloud Artifact and is not stored in local Artifact state.

## Local-first workflow

The canonical local layout is:

```text
<git-worktree>/artifacts/<slug>/
  artifact.json
  .panesignore       # optional
  draft/
  draft.json
  v1/
  v2/
```

Without a Git worktree, the root is `<session-directory>/artifacts/`.
`artifact_prepare` creates the manifest and writable Draft without network
access. A new Draft copies the latest finalized Revision. Existing Drafts must
be explicitly resumed or discarded. Normal OpenCode filesystem tools write the
Draft.

`artifact_import` stages a file or directory into the Draft. It preserves raw
bytes, nested files, empty directories, and portable modes, and rejects unsafe
paths and symlinks. It never removes the source during ordinary import. A
source-path import returns a five-minute verification receipt bound to the
source snapshot and destination. A separate Import call with that receipt and
the same `sourcePath`, `deleteSource: true`, and `confirmDeletion: true`
re-hashes the source immediately before deleting it. Expired, changed, or
mismatched receipts leave the source untouched.

`artifact_finalize` validates one Preview entry and records an immutable local
Revision. The `browser` adapter serves HTML, SVG, or browser-built output
directly. The `renderer` adapter supports React, Markdown, Mermaid, and code.
Renderer wrappers are generated at request time and do not rewrite stored
source. Finalize probes and returns a temporary unguessable
`http://127.0.0.1` Local preview URL. Finalize never contacts Cloudflare.

The local manifest records all local Revision files, including files that will
not be synchronized, plus each Revision's approved origins. Finalized files are
checked by hash and size. Modified files, missing files, unsafe paths, and
manifest mismatches block preview and Sync rather than silently repairing
history.

## Explicit Sync and Creator sharing

`artifact_sync` is the only new cloud creation path. It asks for upload
permission before first Sync, uploads every unsynced finalized Revision in
order, and returns the Cloud inventory URL plus a Creator URL when one is
available. After Owner recovery, explicit Creator-link rotation is required
before a new Creator URL is available. Sync is private and never publishes an
Artifact. It stores exact selected bytes in private R2 and keeps Owner state in
protected local plugin state.

`openCreatorAfterSuccess` defaults to `false`. With `true`, successful Sync
requests the separate `artifact_open` permission after Sync and still returns
the Creator URL when opening is denied or fails. `artifact_publish` is only a
sharing intent: it runs Sync and requests Creator opening. It does not select a
Revision, select a duration, or submit a Publication. The human makes those
choices and confirms Share in the Creator workspace, selecting one synced
Revision and 1, 7, or 30 days. Seven days is the default and permanent
Publication is unavailable. A confirmed Share returns the selected Revision,
expiry, and Public URL in the Creator view. Sharing another synced Revision
while a Share is active updates that same Public URL and expiry in place.

The Owner credential authorizes Sync and Creator-link rotation and is never in
the repository, manifest, URL, or tool output. A Creator link reads and manages
one private cloud Artifact for a fixed 30 days, but cannot delete cloud data or
access inventory. A Public link is limited to the one Revision selected by its
Publication. The Access-protected inventory is a separate administrative
surface for synced Artifacts, deletion, recovery, Publication lifecycle, and
Legacy migration.

An active Public token is retained server-side as a one-way lookup hash and
recoverable encrypted ciphertext under a versioned Worker-managed key. A
Creator-authorized Share response and the Access-protected inventory can
reconstruct its Public URL. Token plaintext and key material are not exposed in
manifests, logs, or analytics. Public-token plaintext appears only in those
authorized active-link results, and key material never leaves Worker secret
storage. Revocation removes recoverable ciphertext immediately; expiry removes
it when an inventory, Creator, or Public request observes the expired record.

## Sync filtering and security

`.panesignore` uses ordered Gitignore-style rules relative to the Artifact root.
Mandatory exclusions cannot be re-included, including `artifact.json`,
`.panesignore`, Draft state, `.env` files, Git internals, dependencies, build
caches, and common key or certificate files. Excluded files do not count toward
remote limits. Panes derives a separate filtered cloud manifest containing only
selected synchronized files, synchronized Revisions, Preview entries, and
approved HTTP(S) origins. Ignored filenames, paths, hashes, and sizes never
appear in it, and the cloud manifest cannot itself be ignored.

Initial remote limits are 25 MiB per file and 100 MiB per Revision after ignore
evaluation. These limits do not limit local Drafts or local Revision history.
Legacy adoption retains its separate 1 MiB UTF-8 source limit.

HTTPS stylesheets, fonts, images, media, scripts, and API calls work by default
without origin approval. The advanced compatibility path accepts exact
normalized plain-HTTP origins and requires the existing nonce approval flow.
Approved origins are immutable per Revision.
`ws:`, `wss:`, and all other schemes are unsupported, and WebSockets remain
blocked.

## Legacy and recovery

Legacy source-string Artifacts are readable but read-only for their migration
window. Their private access expires 30 days after one stable migration
timestamp, and their public links expire after 7 days. The authenticated
inventory exports the current Legacy Revision and issues an adoption code.
`artifact_adopt_legacy` writes unchanged bytes as a local finalized `v1` with
the matching Preview adapter, stores no Owner credential, and permits retries
only for the same local binding. The original Legacy history stays separate.
The first explicit Sync after adoption creates a new cloud identity with Legacy
provenance. The retired source-string mutation routes return
`410 LOCAL_FIRST_REQUIRED`.

If protected Owner state is lost, the Access-protected inventory issues a
single-use reconnect code valid for 10 minutes after explicit confirmation.
`artifact_reconnect` validates the canonical local manifest and synced
Revision metadata before redeeming it. Recovery replaces only the Owner
credential. It does not rotate Creator access or Publication and writes the
replacement to protected local state.

## Verification

```sh
npm run build:plugin
npm test --workspace @opencode-panes/plugin
npm run smoke:plugin
```

The smoke check verifies local-first tool registration through the supported
OpenCode Plugin API. It does not invoke a model, test interactive permissions,
connect to the API, or modify OpenCode configuration.
