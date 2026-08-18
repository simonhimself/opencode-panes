# @opencode-panes/plugin

OpenCode plugin that registers one `artifact` tool for creating and revising OpenCode Panes artifacts. This MIT-licensed package remains private and unpublished.

## Build

```sh
npm install
npm run build --workspace @opencode-panes/plugin
```

## Project Installation

Add the built package to the project's `opencode.json` with an absolute file URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-panes/packages/opencode-plugin/dist/index.js",
      {
        "apiBaseUrl": "http://127.0.0.1:5173",
        "autoOpen": false,
        "requestTimeoutMs": 15000
      }
    ]
  ]
}
```

For global installation, use the same entry in `~/.config/opencode/opencode.json`. Restart OpenCode after changing plugins or commands.

## Configuration

| Option             | Type    | Default                 | Purpose                                               |
| ------------------ | ------- | ----------------------- | ----------------------------------------------------- |
| `apiBaseUrl`       | string  | `http://127.0.0.1:5173` | Panes API origin. Non-loopback origins require HTTPS  |
| `createApiKey`     | string  | unset                   | Optional API creation-admission key                   |
| `autoOpen`         | boolean | `false`                 | Open a validated viewer URL after separate permission |
| `requestTimeoutMs` | integer | `15000`                 | Request timeout from 100 to 120000 milliseconds       |

Prefer `OPENCODE_PANES_CREATE_API_KEY` over a config value. An explicit `createApiKey` option takes precedence. The key is sent only to `POST /api/artifacts` and is not stored in artifact state or returned to the model.

The current test service uses `https://opencode-panes.simons.workers.dev` and requires the separately provided creation key.

Every upload requests `artifact_upload` permission for the exact API origin. Browser opening is disabled by default and uses a separate `artifact_open` permission. Owner tokens are stored atomically under `$XDG_STATE_HOME/opencode-panes`, or the platform state-directory fallback, and never appear in tool output. Titles and types remain immutable across revisions.

Creator URLs contain a workspace capability in the URL fragment. The tool instructs models to preserve that URL exactly. If a model rewrites the final Markdown link without its fragment, use the structured tool result URL or enable `autoOpen` and approve the separate exact-origin browser permission.

## Optional `/artifact` Command

The package includes `commands/artifact.md`. Copy it manually to a project or global command directory:

```sh
mkdir -p .opencode/commands
cp packages/opencode-plugin/commands/artifact.md .opencode/commands/artifact.md
```

For an installed package, copy from `node_modules/@opencode-panes/plugin/commands/artifact.md`. For global use, target `~/.config/opencode/commands/artifact.md`. The command forwards `$ARGUMENTS` and instructs OpenCode to use the registered tool; it does not install or configure the plugin.

## Verification

From the repository root:

```sh
npm run build:plugin
npm test --workspace @opencode-panes/plugin
npm run pack:dry-run
npm run smoke:plugin
```

The smoke script imports the built package and asserts the `artifact` definition through the supported Plugin API without invoking a model or modifying OpenCode config. It does not test full host startup, interactive permissions, API connectivity, or provider behavior.

## Limits

The package requires Node.js 22.12 or newer and OpenCode 1.18.18 or newer. Source is limited to 1 MiB of UTF-8 data. The package is not on npm; the current hosted endpoint is for testing rather than a supported public service.
