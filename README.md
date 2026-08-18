# OpenCode Panes

OpenCode Panes is a locally implemented MVP for creating versioned browser artifacts from an OpenCode `artifact` tool. The workspace contains a React viewer and Cloudflare Worker API, shared contracts, and an OpenCode plugin. It is not deployed or published.

## Workspace

- `apps/web`: Artifact viewer, browser renderers, Worker API, D1 migrations, and tests.
- `packages/contracts`: Shared schemas, limits, and API types.
- `packages/opencode-plugin`: Built OpenCode plugin and optional command template.

## Local Development

Requires Node.js 22.12 or newer and npm 11.

```sh
npm install
npx wrangler d1 migrations apply opencode-panes-local --local --config apps/web/wrangler.jsonc
npm run dev --workspace @opencode-panes/web
```

Build the plugin in another terminal:

```sh
npm run build:plugin
```

Configure OpenCode with the absolute file URL for `packages/opencode-plugin/dist/index.js`. See `packages/opencode-plugin/README.md` for project and global examples. No repository config is installed automatically.

The plugin requests upload permission, creates or revises an artifact, stores owner capability data in the user's state directory, and returns a creator URL. The creator viewer supports all six MVP renderers, immutable revision selection and polling, source highlighting, copy/download, runtime controls, and selected-revision publishing. Public links expose only their pinned revision.

## Creation Key

Production creation admission is optional in code but recommended. The Worker reads `PANES_CREATE_API_KEY`. Launch OpenCode with the matching plugin-side variable instead of putting the key in configuration:

```sh
OPENCODE_PANES_CREATE_API_KEY="your-key" opencode
```

The plugin sends the key only when creating an artifact.

## Optional Command

The distributable template is `packages/opencode-plugin/commands/artifact.md`. Copy it manually if desired. It does not install itself.

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
npm run pack:dry-run
npm run smoke:plugin
npm audit
npm run deploy:dry-run
```

`npm run smoke:plugin` imports the built package entry and asserts registration through the supported OpenCode Plugin API. It does not start the full OpenCode host, invoke a model, exercise permission UI, or modify config.

## Production Deployment

These commands are instructions only. They have not been executed for this MVP.

1. From `apps/web`, run `npx wrangler d1 create opencode-panes`.
2. Replace the placeholder `database_name` and `database_id` in `apps/web/wrangler.jsonc` with the returned values.
3. Run `npx wrangler d1 migrations apply opencode-panes --remote` from `apps/web`.
4. Run `npx wrangler secret put PANES_CREATE_API_KEY` from `apps/web` and enter a strong value at the prompt.
5. From the repository root, run `npm run build:web`.
6. Run `npm run deploy:dry-run:built`, then inspect the generated-config result.
7. Run `npm run deploy:built` to deploy the exact Vite-generated Worker configuration.

The build writes the deployable configuration to `apps/web/dist/opencode_panes/wrangler.json` and Wrangler's redirect to `apps/web/.wrangler/deploy/config.json`. The `:built` scripts run from the web workspace so Wrangler uses that generated configuration.

## Known Limitations

- No npm publication, production D1 database, Worker deployment, or external-user validation has occurred.
- The highlighter is a dependency-free lexical aid, not a complete parser for every language.
- React artifacts use a fixed runtime and import allowlist. Arbitrary packages and server code are unsupported.
- Browser sandboxing reduces risk but does not prove safety against every browser behavior, resource-exhaustion loop, or future API.
- Real cross-browser hostile-loop and provider/model testing remains outstanding.

See `PROJECT_PLAN.md` for exact completion status and remaining release blockers. Licensed under MIT.
