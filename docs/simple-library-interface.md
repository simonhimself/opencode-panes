# Simple library implementation contract

One owner per Cloudflare deployment. Ordinary local files are edited in place.
Only uploads create immutable cloud versions. Uploads are private; sharing is a
separate human action in the authenticated dashboard. No legacy compatibility.

## HTTP interface

- `POST /api/uploads`: Bearer `PANES_UPLOAD_KEY`; UploadRequest -> UploadSession.
  Same idempotency key and identical request safely resumes or returns completed upload.
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
