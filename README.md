# OpenCode Panes

OpenCode Panes is an MVP for creating versioned browser artifacts from OpenCode. The workspace contains a React viewer and Cloudflare Worker API, shared contracts, and a private local OpenCode plugin. The service is deployed for testing; the plugin is intentionally not distributed through a package registry.

## Workspace

- `apps/web`: Artifact viewer, browser renderers, Worker API, D1 migrations, and tests.
- `packages/contracts`: Shared schemas, limits, and API types.
- `packages/opencode-plugin`: Built OpenCode plugin and optional command template.

## Local Development

Requires Node.js 22.12 or newer and npm 11.

```sh
npm install
npx wrangler d1 migrations apply opencode-panes --local --config apps/web/wrangler.jsonc
npm run dev --workspace @opencode-panes/web
```

Build the plugin in another terminal:

```sh
npm run build:plugin
```

Install the bundled global plugin with:

```sh
npm run install:plugin
```

This atomically writes only `opencode-panes.js` to `~/.config/opencode/plugins/` (or the directory selected by `XDG_CONFIG_HOME`). Set `OPENCODE_PANES_CONFIG_DIR` or `OPENCODE_PANES_PLUGIN_DIR` to test or target another config/plugin directory. The installed module has no repository imports and needs no config-directory `package.json`.

The global entry uses `https://opencode-panes.simons.workers.dev`, keeps browser opening disabled, and uses a 15-second request timeout. It reads the optional creation key at startup from `<OpenCode config directory>/secrets/opencode-panes-create-key`; set `OPENCODE_PANES_CREATE_API_KEY_FILE` for another path or use `OPENCODE_PANES_CREATE_API_KEY`. Explicit plugin options remain overrides. Restart OpenCode after installation.

The built package entry remains available for project-local development through an auto-discovered file in `.opencode/plugins/` or `~/.config/opencode/plugins/`. See `packages/opencode-plugin/README.md` for package details.

The legacy `artifact` tool requests upload permission, creates or revises a cloud artifact, stores owner capability data in the user's state directory, and returns a creator URL. The local-first `artifact_prepare` tool creates a project-local manifest and writable Draft without network access or Git mutations. The creator viewer supports all six MVP renderers, immutable revision selection and polling, source highlighting, copy/download, runtime controls, and selected-revision publishing. Local-first public links use `/published/:token`, expose one pinned revision through Worker-mediated private R2 routes, and have no revision or creator controls. The authenticated `/inventory` view groups cloud Artifacts by project and supports Creator-link rotation, Publication lifecycle actions, confirmed cloud-copy deletion, and short-lived, single-use Owner reconnect-code issuance without reading or deleting canonical local files. The plugin's `artifact_reconnect` tool redeems a reconnect code after local protected state loss and stores a replacement Owner credential in protected state. Legacy `/shared/:token` links remain separate.

## Creation Key

Production creation admission is optional in code but recommended. The Worker reads `PANES_CREATE_API_KEY`. Launch OpenCode with the matching plugin-side variable instead of putting the key in configuration:

```sh
OPENCODE_PANES_CREATE_API_KEY="your-key" opencode
```

The plugin sends the key only when creating an artifact.

## Live Test Service

The test deployment is available at `https://opencode-panes.simons.workers.dev`. Configure the plugin with that URL and provide the matching creation key through `OPENCODE_PANES_CREATE_API_KEY`. The service rejects artifact creation without the key; existing creator and public URLs use their own scoped capability tokens.

## Optional Command

The private command template is `packages/opencode-plugin/commands/artifact.md`. Copy it manually if desired. It does not install itself.

```sh
mkdir -p .opencode/commands
cp packages/opencode-plugin/commands/artifact.md .opencode/commands/artifact.md
```

For global use, copy it to `~/.config/opencode/commands/artifact.md`. Restart OpenCode after adding a plugin or command.

## Verification

```sh
npm run format
npm run typecheck
npm test
npm run build
npm run smoke:plugin
npm audit
npm run deploy:dry-run
```

`npm run smoke:plugin` imports the built package entry and asserts registration through the supported OpenCode Plugin API. It does not start the full OpenCode host, invoke a model, exercise permission UI, or modify config.

## Production Deployment

The current deployment uses Worker `opencode-panes` and D1 database `opencode-panes`. To apply future migrations or redeploy:

1. From `apps/web`, run `npx wrangler d1 migrations apply opencode-panes --remote`.
2. To rotate admission credentials, run `npx wrangler secret put PANES_CREATE_API_KEY` and enter a strong value at the prompt.
3. From the repository root, run `npm run build:web`.
4. Run `npm run deploy:dry-run:built`, then inspect the generated-config result.
5. Run `npm run deploy:built` to deploy the exact Vite-generated Worker configuration.

The build writes the deployable configuration to `apps/web/dist/opencode_panes/wrangler.json` and Wrangler's redirect to `apps/web/.wrangler/deploy/config.json`. The `:built` scripts run from the web workspace so Wrangler uses that generated configuration.

## Known Limitations

- The plugin is intentionally private and local-only. Registry publication and external-user release validation are out of scope.
- The highlighter is a dependency-free lexical aid, not a complete parser for every language.
- React artifacts use a fixed runtime and import allowlist. Arbitrary packages and server code are unsupported.
- Browser sandboxing reduces risk but does not prove safety against every browser behavior, resource-exhaustion loop, or future API.
- Real cross-browser hostile-loop and provider/model testing remains outstanding.

See `PROJECT_PLAN.md` for exact local-only completion status and remaining validation items. Licensed under MIT.
