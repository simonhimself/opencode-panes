# @opencode-panes/plugin

OpenCode plugin that registers the local-first `artifact_prepare`, `artifact_import`, `artifact_finalize`, `artifact_sync`, and `artifact_adopt_legacy` tools for OpenCode Panes artifacts. This MIT-licensed workspace package is intentionally private and local-only.

## Build

```sh
npm install
npm run build --workspace @opencode-panes/plugin
```

The build emits the package entry at `dist/index.js` and a standalone global entry at `dist/global.js`.

## Private Local Installation

Create `.opencode/plugins/opencode-panes.js` for project-scoped use, or install the standalone global file with `npm run install:plugin` from the repository root. OpenCode discovers plugin files in those directories automatically.

```js
import PanesPlugin from "file:///absolute/path/to/opencode-panes/packages/opencode-plugin/dist/index.js";

export const OpenCodePanesPlugin = async (context) =>
  PanesPlugin(context, {
    apiBaseUrl: "http://127.0.0.1:5173",
    requestTimeoutMs: 15000,
  });
```

Keep service credentials outside the loader. The plugin reads `OPENCODE_PANES_CREATE_API_KEY` when `createApiKey` is omitted for Sync admission. Restart OpenCode after changing plugins or commands.

The installed global entry defaults to `https://opencode-panes.simons.workers.dev` and a 15-second timeout. It reads the optional Sync admission key at runtime from `<OpenCode config directory>/secrets/opencode-panes-create-key`. The config directory uses `OPENCODE_PANES_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, or `XDG_CONFIG_HOME/opencode`, with `~/.config/opencode` as the fallback. Set `OPENCODE_PANES_CREATE_API_KEY_FILE` to override the key path. `OPENCODE_PANES_API_BASE_URL` and plugin options can override the global API default.

## Configuration

| Option             | Type    | Default                 | Purpose                                              |
| ------------------ | ------- | ----------------------- | ---------------------------------------------------- |
| `apiBaseUrl`       | string  | `http://127.0.0.1:5173` | Panes API origin. Non-loopback origins require HTTPS |
| `createApiKey`     | string  | unset                   | Optional Sync admission key                          |
| `requestTimeoutMs` | integer | `15000`                 | Request timeout from 100 to 120000 milliseconds      |

Prefer `OPENCODE_PANES_CREATE_API_KEY` over a config value. An explicit `createApiKey` option takes precedence. The key is sent only to `POST /api/sync/artifacts` and is not stored in local artifact state or returned to the model.

The current test service uses `https://opencode-panes.simons.workers.dev` and requires the separately provided first-Sync admission key for new cloud-Artifact creation.

Every Sync requests `artifact_upload` permission for the exact API origin. The first Sync creates the cloud Artifact through `artifact_upload`; later Sync calls reuse the protected Owner state. `artifact_sync` accepts `openCreatorAfterSuccess`, which defaults to `false`; when `true`, it requests opening the validated Creator URL only after Sync succeeds and still requires the separate `artifact_open` permission. Sync returns the URL even when opening is denied or fails. Browser opening is disabled by default and uses a separate `artifact_open` permission. Sync credentials are stored atomically under `$XDG_STATE_HOME/opencode-panes`, or the platform state-directory fallback, and never appear in tool output. Local titles and kinds remain stable across revisions.

`artifact_prepare` creates a local Artifact under `<git-worktree>/artifacts/`, or under `<session-directory>/artifacts/` when the session is not in Git. It writes `artifact.json`, a writable `draft/`, and Draft metadata without contacting Cloudflare or changing Git state. Omit `artifactId` to create a safe-slugged Artifact, or provide one to copy its latest finalized revision into a new Draft. Existing slugs and Drafts require an explicit different slug, `draftAction: "resume"`, or `draftAction: "discard"`. Repeating the same request returns the existing preparation state.

`artifact_import` copies one existing file or directory through temporary staging into a complete Draft. It preserves raw bytes, nested files, empty directories, and portable modes, rejects symlinks and unsafe paths, and requires `collision: "replace"` before replacing an existing Draft path. A source-path import returns a short-lived verification receipt. A separate `artifact_import` call with that receipt and `confirmDeletion: true` re-hashes the source immediately before deleting it. Ordinary imports, cancellations, expired receipts, and changed sources leave the source untouched. Source text plus `filename` provides the one-file convenience flow.

`artifact_finalize` validates a Draft's normalized relative entry path through either the direct `browser` adapter or a supported `renderer` adapter (`react`, `markdown`, `mermaid`, or `code`). It records raw-byte hashes, sizes, media types, directories, and portable modes, then promotes the Draft to the next contiguous `vN` directory through a recoverable finalization journal. The returned URL is a temporary, unguessable `127.0.0.1` Local preview for that finalized Revision. Direct browser files remain byte-identical; renderer entries use generated response-time wrappers and do not rewrite stored source. Finalize never contacts Cloudflare. Modified finalized files, deleted entries, unexpected Revision directories, and manifest mismatches block finalization and preview.

Sync returns creator and inventory URLs after cloud admission. Preserve returned URLs exactly when presenting them. Legacy adoption never stores an Owner credential and remains local until an explicit Sync.

## Optional `/artifact` Command

The package includes `commands/artifact.md`. Copy it manually to a project or global command directory:

```sh
mkdir -p .opencode/commands
cp packages/opencode-plugin/commands/artifact.md .opencode/commands/artifact.md
```

For global use, target `~/.config/opencode/commands/artifact.md`. The command forwards `$ARGUMENTS` and instructs OpenCode to use the registered tool; it does not install or configure the plugin.

## Verification

From the repository root:

```sh
npm run build:plugin
npm test --workspace @opencode-panes/plugin
npm run smoke:plugin
```

For the repository-independent global installation:

```sh
npm run install:plugin
```

The installer writes only `opencode-panes.js` and atomically replaces that file. Set `OPENCODE_PANES_CONFIG_DIR` or `OPENCODE_PANES_PLUGIN_DIR` to use an isolated destination.

The smoke script imports the built package and asserts the local-first tool definitions through the supported Plugin API without invoking a model or modifying OpenCode config. It does not test full host startup, interactive permissions, API connectivity, or provider behavior.

## Limits

The private workspace package requires Node.js 22.12 or newer and OpenCode 1.18.18 or newer. Local Draft files use independent file and Revision limits. Registry distribution is not a project goal; the current hosted endpoint supports the private local workflow.
