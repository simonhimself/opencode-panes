# OpenCode Panes Plugin

Two tools upload ordinary browser-ready files to your private Panes library:

- `artifact_upload`: selects `sourcePath` (file or directory), with optional `entryPath`, `title`, and `projectName`. Asks permission before reading file contents or sending an upload. Returns a JSON string containing `artifactId`, `version`, and the authenticated `dashboardUrl`.
- `artifact_dashboard`: returns the owner `/inventory` URL, or `/inventory/artifacts/:id` with an optional cloud `artifactId`. It does not make a network request or share anything.

## Configuration

Set `OPENCODE_PANES_API_URL` to your deployment's HTTPS origin and `OPENCODE_PANES_UPLOAD_KEY` to its upload key in the OpenCode process environment. Plugin options `apiBaseUrl` and `uploadKey` take precedence. There is no default hosted endpoint or key-file lookup. `requestTimeoutMs` defaults to 30000 per HTTP request, including response reads. Plain HTTP is accepted only with a literal loopback IP (`127.0.0.1` or `[::1]`), not a DNS hostname.

The dashboard requires owner authentication. The upload key never appears in returned URLs, permission metadata, or error responses, and is never stored by the plugin. Upload permission uses `artifact_upload`, scoped to the configured API origin.

## Source And Retries

Select an HTML/SVG file or an already-built browser folder inside the current project worktree. Relative sources resolve from the session directory. Folder entries default to `index.html`; `entryPath` is relative to the selected folder. A single-file entry defaults to that file's name. Build framework source with existing local tools first. Use existing browser tools for local preview.

The plugin reads raw bytes, never executes source, and never writes to or deletes source. There are no local drafts, manifests, history, per-artifact credentials, compiler, or preview server. Snapshots are bounded to 500 files, 25 MiB per file, and 100 MiB total. Unsafe paths and symlinks (including source and ancestor components inside the project) are rejected. Contract exclusions omit environment files, private-key files, git metadata, dependencies, caches, and old Panes metadata. `.panesignore` is excluded but is not interpreted. Review selected content for secrets not identifiable by filename.

Project identity hashes a normalized git remote (origin preferred, otherwise the first configured remote), or the real project-root path when no network remote is available. The friendly name is the project directory name or `projectName`. The artifact key is the project-relative selected source path. Moving a source creates a different artifact identity.

An idempotency key hashes the canonical upload request excluding the key itself, including sorted file metadata and SHA-256 hashes. Identical retries resume the same upload via `POST /api/uploads`, file `PUT`s, and `POST /api/uploads/:id/commit`. A completed upload skips file transfers and safely repeats commit. Changed bytes or request metadata produce a new key. Cancellation and timeouts stop further work; retry after a partial upload without changing the source. Sharing is only an explicit human dashboard action.

## Build And Verification

From the repository root:

```sh
npm run build --workspace @opencode-panes/plugin
npm run typecheck --workspace @opencode-panes/plugin
npm run test --workspace @opencode-panes/plugin
node scripts/smoke-plugin.mjs
```

The build emits one standalone JavaScript bundle, `dist/global.js`, plus TypeScript declarations. No runtime dependency directory, React runtime, or compiler WASM is needed. The installer copies only the bundle, atomically, and does not modify OpenCode JSON configuration. Installer tests use temporary directories, not a real global installation. Installing or updating the plugin requires quitting and restarting OpenCode; running sessions keep their loaded plugin.
