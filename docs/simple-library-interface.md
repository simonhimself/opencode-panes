# Simple library implementation contract

One owner per Cloudflare deployment. Ordinary local files are edited in place.
Only uploads create immutable cloud versions. Uploads are private; sharing is a
separate human action in the authenticated dashboard. No legacy compatibility.

## HTTP interface

- `POST /api/uploads`: Bearer `PANES_UPLOAD_KEY`; UploadRequest -> UploadSession.
  Same idempotency key and identical request safely resumes or returns completed upload.
  An unfinished session has a fixed seven-day window from creation. After expiry,
  the same request automatically starts a new upload ID on the same artifact.
- `PUT /api/uploads/:uploadId/files/:path`: same upload authorization; exact raw bytes,
  validate selected path, size and SHA-256 before storing. Successful response 204.
- `POST /api/uploads/:uploadId/commit`: same authorization; verifies all files before
  creating one immutable version. Returns UploadResult; safe repeat.
- `GET /api/library`: Cloudflare Access owner authentication -> ArtifactLibrary.
- `GET /api/library/artifacts/:id`: same authentication -> LibraryArtifact.
- `PUT /api/library/artifacts/:id/share`: same authentication + same-origin CSRF
  protection; ShareRequest -> ArtifactShare. Active link remains stable when updating.
  `expiresInDays: null` means no expiry; finite duration starts at this explicit action.
- `DELETE /api/library/artifacts/:id/share`: owner + CSRF; revoke link, return 204.
- `DELETE /api/library/artifacts/:id`: owner + CSRF; delete cloud artifact only, 204.
- `GET /api/shares/:token`: public read -> PublicArtifact; revoked/expired links fail closed.
- `GET /api/shares/:token/versions/:versionId/files/:path`: selected version only.
- `GET /api/previews/:token/files/:path`: short-lived signed read-only capability for
  exactly one committed version. No management capability ever reaches artifact code.

Owner dashboard routes: `/inventory` and `/inventory/artifacts/:id` (Access-protected).
Public viewer: `/s/:token`. Root redirects to `/inventory`. Preview URLs are supplied
by server and use sandbox CSP, safe MIME types, no referrers and no-store. Supporting
relative asset paths must work. Public asset URLs bind a version to avoid mixing files
across a share update. HTML/SVG and locally built browser folders only. HTTPS resources
are permitted; no HTTP-origin approval state and no server-side artifact execution.

Dashboard uses the shared TypeScript shapes. Versions are sorted newest-first. Projects
have stable IDs and friendly names. Default sharing is no expiry, with 1/7/30 day options.
Revocation invalidates the old link; sharing again creates a new one.

Plugin exposes only `artifact_upload` and `artifact_dashboard`. Upload selects file/folder,
optional entry/title/project name, derives stable project/source identity, asks upload
permission, excludes secrets/dependencies, uploads a stable snapshot without writing to
source, and returns the authenticated dashboard URL. No automatic sharing.

## Abandoned uploads

The cutoff is inclusive: an uncommitted upload expires when `created_at` is at
least seven days old. PUTs and start retries do not refresh it. PUT and commit
requests using an expired ID return `410` with
`{"error":"Upload expired; start a new upload"}`, even before the next cron run.
The plugin can remain unchanged: its next `artifact_upload` starts with POST and
receives a fresh session. Committed uploads remain idempotent indefinitely,
regardless of private/public status or share expiry. Failed partial uploads never
allocate version numbers or appear in inventory.

Expiry atomically marks `library_uploads.expired_at`, replaces the unique request
key with `expired:<uploadId>`, and clears the manifest to `{}`. Clients can only
supply 64-character hexadecimal keys, so they cannot claim these markers. The
original key is released, not permanently bound to discarded metadata: a changed
manifest may use that released key for a new session. A key held by a fresh or
committed session still rejects a different manifest with 409. Deleted artifacts
retain their existing denial behavior; expiry does not release their keys.

Both expiry and version insertion are guarded SQL statements. Expiry excludes
any ID in `library_versions`; commit requires an unexpired, still-fresh upload and
a live artifact. If commit wins, cleanup cannot claim or delete its objects. If
expiry wins, commit cannot create a version. PUT remains create-only and rechecks
the session after storage, deleting its own bytes if the upload has expired.

The existing hourly cron selects at most 20 eligible upload IDs, ordered by
`COALESCE(cleanup_checked_at, created_at)` then ID. It atomically claims expiry and
records each cleanup attempt before R2 access. Each claimed ID gets only one R2
list with `limit: 100`, followed by deletion of those keys, strictly within
`library/<artifactId>/<uploadId>/`. It never purges a whole artifact for an
abandoned session. Successful first-page deletion exposes the next page on a later
run, so there is no cursor or unbounded pagination loop. Failed prefixes rotate
behind older work; other selected prefixes and existing artifact-deletion cleanup
still run, and the invocation reports a sanitized failure for operational visibility.

Denial receipts are retained and revisited even after a prefix is empty. This
small metadata and recurring-list cost closes the nontransactional D1/R2 crash
window: a PUT can finish after cleanup, then crash before its final denial check.
Periodic rechecks collect those bytes without resurrecting old upload IDs. Finite
backlogs drain over multiple runs; cleanup throughput is bounded, not instantaneous.
These limits apply to abandoned-upload housekeeping, not the existing explicit
artifact-deletion purge. No queue, additional Worker, or per-file heartbeat is added.

Migration `0012_abandoned_upload_cleanup.sql` adds nullable `expired_at` and
`cleanup_checked_at` columns and the cleanup-order index. Existing committed rows
keep null markers and their manifests. Apply the migration before the updated
Worker; existing unfinished sessions already seven days old are immediately
eligible when requests or cron reach them. Legacy retirement is a separate rollout.

Primary API semantics: [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
and [R2 list/delete and strong consistency](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
