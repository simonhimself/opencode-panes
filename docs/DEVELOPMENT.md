# Development and verification

Requires Node.js 22.12 or newer and npm 11.

```sh
npm install
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
standalone bundle outside the repository without installing it globally. The
dry-run builds a deployment bundle without deploying it.

## Local Worker and acceptance test

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

For a step-by-step owner trial with copy-ready prompts, use the
[manual test guide](manual-testing.md).

## Sandbox form regression

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

The implementation and browser checks for v0.3 are recorded in
[simple-library-verification.md](simple-library-verification.md).
