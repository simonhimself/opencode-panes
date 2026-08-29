# OpenCode Panes

OpenCode Panes manages locally created artifacts, their revision history, and optional Cloudflare sharing.

## Language

**Artifact**:
A browser-side prototype stored in its own project directory as numbered revision directories. Each revision may contain arbitrary files and declares one browser preview entry point, but is not a deployable backend application.
_Avoid_: Deployment, application service

**Revision**:
An immutable, visibly numbered directory containing one state of an artifact. A later change creates a new revision directory instead of modifying an earlier one.
_Avoid_: Version, save

**Draft**:
The temporary working directory used while the model creates and validates the next revision. It receives a revision number only after validation succeeds.
_Avoid_: Revision, autosave

**Import**:
Recursively copying an existing file or directory into a new artifact directory. Removing the original is a separate, explicitly confirmed action after Panes verifies that the source has not changed.
_Avoid_: Move, register in place

**Local preview**:
A temporary loopback URL for reviewing one validated local revision from the OpenCode session. It is not a local inventory or a cloud creator link.
_Avoid_: Local dashboard, creator link

**Preview entry**:
The file and Preview adapter Panes opens for a revision. A browser entry is served directly; a renderer entry is wrapped by a supported Panes renderer. Framework source may be included freely, but must produce one of those validated entries before the revision can sync.
_Avoid_: Source root, application server

**Sync**:
The upload of every unsynced revision to private Cloudflare storage. It may be requested directly or performed as the first stage of publishing, and does not itself make any revision public.
_Avoid_: Publish, deploy

**Cloud manifest**:
The non-secret manifest derived during Sync from the canonical local artifact manifest and the final upload set. It lists only synchronized revisions and files; ignored local filenames and hashes never appear in it.
_Avoid_: Canonical artifact manifest, local inventory

**Publication**:
The server-side state granting time-bounded public access to one synced revision. It records the selected revision, status, and expiry but is not itself the bearer URL.
_Avoid_: Sync, creator link, public link

**Public link**:
The expiring bearer URL for one active publication. Its public token authorizes only the revision selected by that publication and its supporting files.
_Avoid_: Publication, creator link, permanent share URL

**Public token**:
The secret capability embedded in a Public link and evaluated on each public request. It is credential material, not the Publication record or the display URL.
_Avoid_: Publication, public URL, creator token

**Creator link**:
An expiring bearer capability for viewing and managing one private synced artifact. It permits publishing and unpublishing but not cloud deletion.
_Avoid_: Login, public link, permanent owner URL

**Owner credential**:
A persistent local secret that authorizes syncing and creator-link rotation for one cloud artifact. It is never stored in the project or included in a URL.
_Avoid_: Creator link, creation key

**Cloud inventory**:
The authenticated view of all synced artifacts and their publications. It does not include local-only artifacts.
_Avoid_: Local inventory, artifact gallery

**Legacy artifact**:
A cloud-first artifact created before local revisions became canonical. It is read-only until exported and adopted into a project artifact directory.
_Avoid_: Synced artifact, local artifact
