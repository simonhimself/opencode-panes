# Security model

Owner login, machine uploads, private previews, and public sharing are separate.
Artifact code never receives an owner or upload credential. Private preview
URLs are short-lived and read-only for one version. Public file requests are
bound to the selected shared version and check expiry and revocation.

## Sandboxed previews

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

## Uploaded content

Panes preserves raw bytes and excludes environment files, common private-key
files, Git internals, dependencies, and caches. Exclusions are not a secret
scanner: **only select content you intend to upload, and never embed secrets in
a browser artifact.** Anyone with a share link can access that version's uploaded
files, not only its rendered preview. Panes does not apply `.panesignore` or
`.gitignore` rules.

## Revocation

**Unpublish** immediately stops access through that link. Neither unpublishing
nor deleting an artifact can erase copies someone has already downloaded or
content already loaded in their browser. Test revocation by making a fresh request.

See [operations](OPERATIONS.md) for the Access and credential setup that
enforces these boundaries.
