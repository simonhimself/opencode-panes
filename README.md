# OpenCode Panes

**Make anything locally. Upload it privately. Share it when you are ready.**

Panes is an open-source **OpenCode plugin** with a Cloudflare-hosted visual
library. Each deployment has one owner. Collaborators view the links you share;
they do not get access to your dashboard.

## How it works

1. Ask OpenCode to create an HTML file, SVG, or browser-ready prototype folder.
2. Ask it to upload that file or folder to Panes.
3. Open your library to browse your work by project and preview uploaded versions.
4. Select a version and click **Publish** to get a share link.

Uploads are private. Local edits do not change cloud versions, and new uploads
do not change what collaborators see. **Update shared version** explicitly
updates an active link without changing its URL. Links have no expiry by default;
you can instead choose 1, 7, or 30 days. **Unpublish** immediately stops access
through that link. Sharing again creates a new link.
Updating with a finite duration restarts that duration at confirmation; the
confirmation also makes an explicit switch to no expiry visible.

Panes never moves your source, creates local revision directories, changes Git,
or requires a Draft/Finalize workflow.

## Everyday use

Once the plugin and your deployment are configured, work through OpenCode in
plain language. You do not need to call the tools yourself.

**Create and upload**

> Create a checkout prototype in `mockups/checkout/` with an HTML entry and
> relative CSS and JavaScript assets. Then upload that folder to Panes, titled
> Checkout prototype. Keep it private and give me its dashboard link.

Select a file for a self-contained HTML or SVG, or select the whole folder when
the entry depends on neighboring assets. Sources must be inside the current
project. Folder entries default to `index.html`. Panes asks permission to upload;
it never builds a framework project or publishes on your behalf.

**Find and review your work**

> Give me the link to my Panes dashboard.

Use the project navigation, search, and sharing-status filters to find an
artifact. Click its card to open the preview. The version selector lets you
review earlier uploaded versions. Your dashboard link is for you; it is not the
link to send to collaborators.

**Share a version**

In the dashboard, choose the version, choose **No expiry** or a duration, click
**Publish**, and confirm. Use **Copy link** or **Open** on the resulting share.
Anyone holding that link can view the selected version and access its uploaded
files. A collaborator does not need your owner login.

**Revise without changing the shared version**

> Update `mockups/checkout/` to add an order summary. Upload the same folder
> again with the same title. Do not change the shared version.

Keep the same project, source path, title, and project-name override throughout
the workflow. A new snapshot creates another cloud version. Uploading an identical
snapshot again, including its metadata, reuses its original cloud version instead
of creating a duplicate. Moving the source to a different path identifies a
different artifact.

After reviewing the new version, click **Update shared version** and confirm to
update the active link. A card labeled **Latest v2 / Shared v1** means the latest
upload is not yet the one collaborators see.

**Stop sharing or remove an artifact**

- **Unpublish** disables the current link and keeps all cloud versions private.
- Publishing again after unpublish creates a new link; the old one stays invalid.
- **Delete artifact** removes the cloud artifact and all its uploaded versions,
  with a separate confirmation. It does not delete your local files.
- Neither action can erase copies someone has already downloaded or content
  already loaded in their browser. Test revocation by making a fresh request.

For a step-by-step trial with copy-ready prompts and expected results, use the
[manual test guide](docs/manual-testing.md).

## Supported content

- HTML and SVG files.
- Browser-ready folders containing HTML, CSS, JavaScript, images, fonts, and assets.
- Locally built output from React or other frontend frameworks.

Framework source must be built locally before upload. Panes does not compile
React source, render Markdown or Mermaid source, install packages, execute code
on the server, or host application backends. HTTPS resources are allowed in
previews; ordinary browser CORS and sandbox restrictions still apply. Use
relative asset URLs so files resolve within the uploaded version.

An upload supports up to 500 files, 25 MiB per file and 100 MiB total. Panes
preserves raw bytes and excludes environment files, common private-key files,
Git internals, dependencies, and caches. Exclusions are not a secret scanner:
**only select content you intend to upload, and never embed secrets in a
browser artifact.** Anyone with a share link can access that version's uploaded
files, not only its rendered preview.
Panes does not apply `.panesignore` or `.gitignore` rules. Select a dedicated
artifact or build-output folder rather than relying on an ignore file to protect
unrelated project content.

## Install the OpenCode plugin

Requires Node.js 22.12 or newer and npm 11.

```sh
npm install
npm run install:plugin
```

The installer builds one standalone `opencode-panes.js` file and installs it
under your OpenCode plugin directory. It does not change OpenCode configuration
or install a skill. Set these environment variables when starting OpenCode:

| Variable                    | Value                                                |
| --------------------------- | ---------------------------------------------------- |
| `OPENCODE_PANES_API_URL`    | Your Panes deployment's HTTPS origin                 |
| `OPENCODE_PANES_UPLOAD_KEY` | The secret matching your Worker's `PANES_UPLOAD_KEY` |

Keep the upload key in your shell's secret management, not a repository or a URL.
Quit and restart OpenCode after installing the plugin or changing its environment.
This repository does not provide a shared hosted account or default to someone
else's deployment.

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

The plugin exposes two tools:

- `artifact_upload`: upload a selected local file or browser-ready folder privately.
- `artifact_dashboard`: return the authenticated library URL; it does not open
  a browser itself.

For example, ask: "Upload `mockups/checkout/` to Panes with `index.html` as the
entry, titled Checkout prototype." Use the same source path for later uploads
of the same artifact. There is no plugin tool that publishes content.

## Host your own library

Panes uses a Worker for its UI and HTTP interface, D1 for project/version/share
metadata, and one private R2 bucket for artifact files. All file delivery goes
through Worker authorization. Do not make the bucket public.

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

Cloudflare references: [private R2 through Workers](https://developers.cloudflare.com/r2/get-started/workers-api/)
and [path-specific Access protection](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path).

## Security model

Owner login, machine uploads, private previews, and public sharing are separate.
Artifact code never receives an owner or upload credential. Private preview
URLs are short-lived and read-only for one version. Public file requests are
bound to the selected shared version and check expiry and revocation.

Executable content runs inside sandboxed browser frames without same-origin
privileges. File responses also carry sandbox and content-security-policy
headers, so opening a file directly does not bypass the sandbox. Client-side form
submit handlers and browser validation work in previews. CSP `form-action 'none'`
blocks native form submissions **from Panes-served artifact documents**. It does
not govern unrelated third-party documents embedded in a preview or loaded by
navigating the guest frame: those documents use their own CSP, while the iframe
sandbox still denies parent-origin privileges. HTTPS network access (including
programmatic fetch), HTTPS embedding, and guest-frame navigation remain available
subject to existing browser restrictions. This is isolation from the dashboard,
not total network blocking or an offline execution environment. Browser sandboxing
cannot prevent every malicious page or resource-exhaustion loop.

## Development and verification

The checked-in example at `examples/fieldnotes/` exercises a browser entry,
relative stylesheet, module JavaScript, and SVG. A local-only end-to-end check,
`npm run test:acceptance`, runs the built plugin against a local Worker and
leaves one uploaded example available for browser inspection. It requires
`OPENCODE_PANES_API_URL` (a literal loopback HTTP origin) and
`OPENCODE_PANES_UPLOAD_KEY` matching that local Worker's test key.

For local owner access, explicitly set the Worker variable `PANES_DEV_MODE` to
`"true"` through Wrangler's local `--var` override and bind the server to
`127.0.0.1`. The bypass only applies to loopback hostnames; upload authentication
is still required. Production configuration keeps it `"false"`. Use a disposable
local database with the same `--persist-to` path for local migration and dev
commands. Never point acceptance tests at a hosted deployment.

```sh
npm run format
npm run typecheck
npm test
npm run build
npm run smoke:plugin
npm run deploy:dry-run:built
```

Tests cover the upload and share interface, immutable file bytes, owner and
machine authorization, read-only preview isolation, expiry/revocation, plugin
permissions, and dashboard interactions. The plugin smoke check loads the
standalone bundle outside the repository without installing it globally.

For a focused real-Chromium form regression, use an existing Playwright installation
and installed Google Chrome (no project dependency or hosted content is needed):

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm exec --yes --package=node@22 -- node --experimental-transform-types scripts/verify-sandbox-forms.mjs
```

This local fixture uses the production file headers and iframe permissions.
It checks required-field validation, click/Enter/`requestSubmit()` handlers, and
blocked native GET/POST submissions from Panes-served documents, including
`HTMLFormElement.prototype.submit.call(form)` bypassing submit handlers. It also
checks parent DOM isolation, direct file viewing, and negative controls missing
`allow-forms` at either sandbox layer. A controlled HTTPS child, fulfilled entirely
by Playwright without external network traffic, demonstrates that sandbox origin
isolation is inherited but the parent's `form-action` is not. Worker and UI tests
separately cover the actual private, public, and thumbnail entry paths. The behavior follows the HTML
[form submission algorithm](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-submission-algorithm)
and CSP [form-action pre-navigation check](https://www.w3.org/TR/CSP3/#directive-form-action).

Regenerate binding types after changing Worker configuration with
`npx wrangler types --strict-vars=false` from `apps/web`.

This version intentionally replaces the v0.1/v0.2 workflows. Old Creator links,
local manifests, recovery/adoption tools, and source-string APIs are not supported.
Historical migrations remain in Git; old cloud data is not automatically exposed
by the new library. Existing remote data is not erased by merely building this
version.

## Before and now

The goal has not changed: create artifacts in OpenCode and share them through
Cloudflare. What changed is how much Panes asks you to manage.

| Area                        | Before: v0.2                                          | Now                                                            |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Local work                  | Managed Drafts and immutable local `vN` folders       | Ordinary editable files in your project                        |
| Getting work into the cloud | Finalize, then Sync all unsynced local history        | Upload the selected file or folder as one snapshot             |
| Version history             | A local ledger synchronized to the cloud              | Cloud versions created by uploads; Git remains separate        |
| Private management          | Inventory plus expiring Creator links                 | One owner dashboard with stable navigation links               |
| Organization                | Administrative cards with lifecycle metadata          | Light visual library with projects, search, and sharing status |
| Sharing                     | Creator/Publication terminology and mandatory expiry  | Publish, Copy link, Update shared version, and optional expiry |
| Source formats              | Built-in React, Markdown, Mermaid, and code renderers | HTML, SVG, and locally built browser-ready output              |
| Recovery and migration      | Per-artifact reconnect and legacy adoption            | No per-artifact recovery or compatibility workflow             |

v0.1 was simpler than v0.2, but it uploaded a single source string immediately.
The new version is not a rollback: it keeps multi-file support and explicit
private uploads while removing the managed local lifecycle.

Security was not removed. Owner authentication, private storage, isolated
previews, safe paths, secret-file exclusions, checksums, and explicit sharing
remain. Cloudflare still supplies the Worker, D1, and private R2 storage.

See `CONTEXT.md` for the small product vocabulary, `PROJECT_PLAN.md` for accepted
scope, and `docs/simple-library-interface.md` for the HTTP interface. MIT licensed.
See [v0.3 release notes](docs/releases/v0.3.md) for the breaking changes.
The [v0.3.1 patch](docs/releases/v0.3.1.md) fixes client-side form handling.
The implementation and browser checks are recorded in
`docs/simple-library-verification.md`.
