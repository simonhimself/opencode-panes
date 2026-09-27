# Operations

How to host your own Panes library and configure the plugin against it. Each
deployment has one owner. This repository does not provide a shared hosted
account or default to someone else's deployment.

## Architecture

Panes uses a Cloudflare Worker for its UI and HTTP interface, D1 for
project/version/share metadata, and one private R2 bucket for artifact files. All
file delivery goes through Worker authorization. Do not make the bucket public.

## Host your own library

1. Create your own Cloudflare Worker, D1 database, and private R2 bucket. Configure
   their names and database ID in `apps/web/wrangler.jsonc` for your deployment.
2. Configure a Cloudflare Access self-hosted application covering `/inventory`,
   `/inventory/*`, `/api/library`, and `/api/library/*` on your deployment hostname.
   Allow only your email address. Configure `PANES_ACCESS_ALLOWED_EMAIL`,
   `PANES_ACCESS_ISSUER`, and `PANES_ACCESS_AUDIENCE` to match that application.
3. Do not put the entire Worker behind Access: `/s/*`, `/api/shares/*`,
   `/api/previews/*`, and `/api/uploads*` use their own narrowly scoped authorization.
   The Worker independently verifies owner Access JWTs before returning private data.
4. Set a strong random `PANES_UPLOAD_KEY` Worker secret and use the same value in
   the plugin. The machine key permits uploads, not dashboard access or sharing.
5. Apply the D1 migrations to your database, build, and deploy the Worker.

From `apps/web`, the relevant administrative commands are:

```sh
npx wrangler secret put PANES_UPLOAD_KEY
npx wrangler d1 migrations apply opencode-panes --remote
```

From the repository root:

```sh
npm run build
npm run deploy:dry-run:built
npm run deploy:built
```

The secret command updates the live Worker secret and deploys a Worker version;
the remote migration changes D1, and the deploy command uploads the application.
A build or dry-run does not deploy. Review your
resource configuration first; replace `opencode-panes` with your database name
when appropriate.

Regenerate binding types after changing Worker configuration with
`npx wrangler types --strict-vars=false` from `apps/web`.

Cloudflare references: [private R2 through Workers](https://developers.cloudflare.com/r2/get-started/workers-api/)
and [path-specific Access protection](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path).

## Abandoned-upload cleanup

Migration `0012_abandoned_upload_cleanup.sql` adds upload-expiry and cleanup-check
timestamps, initially null for existing rows. Apply it before running the updated
Worker. Seven-day-old unfinished uploads become eligible immediately; this is not
a new seven-day grace period after deployment. No committed version is eligible.
The existing hourly cron checks up to 20 abandoned upload prefixes and deletes up
to 100 objects per prefix per run. Larger or interrupted deletions continue on
later runs. Small upload-ID denial receipts remain and rotate through periodic
checks to catch late writes after crashes; manifests are discarded on expiry.
This cleanup is separate from explicit artifact deletion and legacy-data retirement.
See [storage cleanup](storage-cleanup.md) for both cleanup operations.

## Plugin configuration

The simplest setup uses environment variables when starting OpenCode:

| Variable                    | Value                                                |
| --------------------------- | ---------------------------------------------------- |
| `OPENCODE_PANES_API_URL`    | Your Panes deployment's HTTPS origin                 |
| `OPENCODE_PANES_UPLOAD_KEY` | The secret matching your Worker's `PANES_UPLOAD_KEY` |

Keep the upload key in your shell's secret management, not a repository or a URL.
Quit and restart OpenCode after installing the plugin or changing its environment.

Alternatively, configure plugin options with a protected secret-file reference.
Install outside the auto-discovered `plugins/` directory so auto-discovery does
not override the explicit options:

```sh
OPENCODE_PANES_PLUGIN_DIR="$HOME/.config/opencode/panes" npm run install:plugin
```

Add an entry to your existing OpenCode `plugin` array, using your actual absolute
bundle path and an existing protected upload-key file:

```json
[
  "file:///absolute/path/to/opencode/panes/opencode-panes.js",
  {
    "apiBaseUrl": "https://your-panes-deployment.example",
    "uploadKey": "{file:~/.config/opencode/secrets/panes-upload-key}"
  }
]
```

Use one installation method, not two copies of the plugin. On upgrades, use the
same installation directory. The file reference is resolved by OpenCode; the
plugin itself does not discover secret files. Restart OpenCode after configuring.
