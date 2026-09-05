# OpenCode Panes Product Direction

## Product promise

> Make anything locally. Upload it privately to Panes. Organize and preview it
> by project. Publish a chosen version when you are ready.

One owner per deployment, hosted in that owner's Cloudflare account. This is an
open-source OpenCode plugin and a private visual library, not a multi-tenant
service or a local version-control system.

## Accepted workflow

1. OpenCode creates ordinary local HTML, SVG, or browser-ready folders.
2. The owner asks to upload a file or folder. Framework projects are built locally.
3. Panes snapshots the selected files without changing them and uploads privately.
4. The owner opens a light, project-organized library with recognizable previews.
5. The owner reviews a cloud version and explicitly publishes it.
6. Sharing defaults to no expiry, with 1-, 7-, and 30-day choices available.
7. Later uploads remain private until the owner updates the shared version.
8. Updating an active share preserves its link. Unpublish invalidates that link;
   publishing again creates a new one. Cloud deletion never deletes local files.

## Scope

- Ordinary editable local files; no Panes Draft, Finalize, or local version ledger.
- Direct upload and dashboard tools only. No plugin publishing action.
- Independent immutable cloud versions; no full-history synchronization.
- Friendly projects, visual artifact library, search and sharing-state filters.
- Preview-first artifact detail with version selection and clear share controls.
- One authenticated owner dashboard; no Creator links or per-artifact recovery.
- Browser-ready output only; no built-in React compiler or document renderers.
- Private R2 objects, D1 metadata, and Worker-mediated authorization.
- Read-only isolated previews with HTTPS dependencies; no HTTP approval handshake.
- Bounded, checksum-verified uploads, safe paths, and mandatory secret exclusions.
- Safe interrupted-upload retry and an atomic visibility point for completed versions.

## Explicit removals

The owner approved a fresh start on September 5, 2026. Old artifacts, share links,
and plugin protocols do not require compatibility. Historical database migrations
remain immutable, but the old application routes, renderers, adoption, reconnect,
source-deletion receipts, and local revision machinery are retired.

No backend hosting, cloud framework builds, arbitrary package execution,
collaborator editing, multi-user accounts, or automatic Git operations are added.

## Acceptance

The implementation must pass formatting, TypeScript checks, Worker and UI tests,
plugin tests and standalone bundle smoke checks, production builds, and Worker
deployment dry-run. Browser acceptance must cover a real local upload, project
navigation, sharing and updating, public access, unpublish, and mobile layout.

Deployment, remote database migration, package publication, and installation into
the running user's OpenCode configuration require separate approval. Local
acceptance is not a claim that the hosted deployment has changed.
