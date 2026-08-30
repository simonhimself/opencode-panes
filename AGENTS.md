# AGENTS.md

## Project

OpenCode Panes is an npm workspace containing a React artifact viewer, a Cloudflare Worker API, shared contracts, and an OpenCode plugin.

## Requirements

- Use Node.js 22.12 or newer and npm 11.
- Keep changes small and consistent with the existing TypeScript and ESM code.
- Preserve raw artifact content unless a task explicitly requires transformation.
- Do not edit secrets, local OpenCode configuration, or generated deployment files.
- Do not deploy, publish packages, or apply remote D1 migrations without explicit approval.

## Workspace

- `apps/web`: Viewer, renderers, Worker API, D1 migrations, and tests.
- `packages/contracts`: Shared schemas, limits, and API types.
- `packages/opencode-plugin`: OpenCode plugin, build configuration, and command template.
- `scripts`: Repository-level verification and maintenance scripts.

## Commands

Install dependencies with `npm install`.

Run these checks after relevant changes:

```sh
npm run format
npm run typecheck
npm test
npm run build
npm run smoke:plugin
```

For Worker configuration changes, also run:

```sh
npm run deploy:dry-run
```

## Change Guidelines

- Update shared contracts before changing both the plugin and Worker API.
- Add D1 schema changes as new migrations. Never rewrite an applied migration.
- Keep creator capabilities and public share capabilities separate.
- Public views must expose only the immutable revision selected for publication.
- Maintain sandbox boundaries when changing artifact renderers.
- Add or update tests for behavior changes and regressions.
- Update `README.md` and `PROJECT_PLAN.md` when documented behavior or scope changes.

## Git

- Do not modify unrelated worktree changes.
- Do not commit, push, publish, or deploy unless explicitly requested.
- Use semantic commit messages such as `feat(plugin): add local artifact preview`.

## Agent skills

### Issue tracker

Issues live as Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout. See `docs/agents/domain.md`.
