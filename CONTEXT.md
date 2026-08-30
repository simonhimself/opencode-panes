# OpenCode Panes Context

OpenCode Panes treats the project filesystem as canonical. Cloudflare stores
an optional private synchronized copy and sharing state.

## Terms

**Artifact**
A project-local directory under `artifacts/<slug>/` with `artifact.json`, an
optional `.panesignore`, temporary Draft state, and finalized Revisions. It is
a browser-side prototype, not a deployable backend application.

**Draft**
A temporary writable directory at `artifact/draft/`, described by
`draft.json`. Preparing the next Draft copies the latest finalized Revision.
Existing Drafts require an explicit resume or discard choice. Drafts are never
uploaded.

**Revision**
An immutable, visibly numbered `vN/` directory and manifest entry. Finalized
numbers are contiguous. A later change creates a new Revision; Panes refuses to
preview or Sync a changed finalized Revision.

**Preview adapter**
The Revision's declared entry mode. `browser` serves HTML, SVG, or browser-built
output directly. `renderer` wraps supported React, Markdown, Mermaid, or code
source at request time without changing stored bytes.

**Local preview**
A temporary, unguessable loopback URL for one validated local Revision. It is
not a local inventory and not a Creator link. It expires with the Panes process
and can be reopened with a new URL.

**Import**
A staged copy of an existing file or directory into a Draft. It preserves raw
bytes, nested files, empty directories, and portable modes, and does not remove
the source. A five-minute verification receipt is returned for source-path
imports.

**Verification receipt**
A five-minute, process-local capability bound to the source path, source
snapshot, import operation, and destination Artifact. A separate Import call
with explicit confirmation re-hashes the source before deletion. Expired,
unknown, mismatched, or changed receipts leave the source untouched.

**Sync**
An explicit upload of every unsynced finalized Revision, in local version order,
to private cloud storage. Sync creates the cloud identity on first use and does
not make a Revision public.

**Cloud manifest**
A non-secret manifest derived from the canonical local manifest and final Sync
upload set. It contains only synchronized Revisions, Preview metadata, approved
origins, and selected files. Ignored filenames, paths, hashes, and sizes, plus
local control files, are absent.

**`.panesignore`**
An optional ordered Gitignore-style file at the Artifact root. Its rules apply
only to Revision content during Sync. Mandatory exclusions, including secrets,
Git internals, dependencies, Drafts, and build caches, cannot be re-included.
Excluded files do not count toward remote limits.

**Requested origin**
An exact normalized `http` or `https` origin requested by a Draft for the
advanced plain-HTTP compatibility path. HTTPS dependencies work by default and
do not need a requested origin.

**Approved origin**
The exact HTTP(S) origin set approved for one immutable Revision. Panes derives
CSP directives from it. HTTPS is allowed by default; plain HTTP remains blocked
unless its exact origin is approved. `ws`, `wss`, and other schemes are
unsupported and stay blocked; WebSockets are not available.

**Owner credential**
A persistent local secret for one cloud Artifact. It authorizes Sync and
Creator-link rotation. It lives only in protected plugin state, is not a URL
token, and is never stored in the project manifest.

**Creator link**
An expiring bearer capability for one private synced Artifact. It can read all
synced Revisions and manage Publication, but cannot delete cloud data or access
the Cloud inventory. It has a fixed 30-day lifetime; rotation revokes the old
link and starts a new period.

**Publication**
Server-side state granting public access to exactly one synced Revision for 1,
7, or 30 days. Seven days is the default. There is at most one active
Publication per Artifact. Updating its selected synced Revision preserves its
Public URL and expiry. Expired and revoked Publication records remain as
server-side history. Creator exposes the full history; inventory reports the
current or latest Publication state. Private synced files do not expire with a
Publication.

**Public link / Public token**
The Public link is an expiring bearer URL. Its token authorizes only the
Revision selected by its Publication and its supporting files. Active tokens
are stored server-side as a lookup hash plus recoverable encrypted ciphertext
under a versioned Worker-managed key. A Creator-authorized sharing response and
the Access-protected inventory can reconstruct an active link. Token plaintext
and key material are not exposed in manifests, logs, or analytics. Public-token
plaintext appears only in those authorized active-link results, and key
material never leaves Worker secret storage. Revocation removes recoverable
ciphertext immediately; expiry removes it when an inventory, Creator, or Public
request observes the expired record.

**Cloud inventory**
The Access-protected administrative view of synced cloud Artifacts, grouped by
project. It shows current Artifacts before collapsed Legacy history. Recovery
and destructive controls are available behind Manage. It shows Revision and
storage metadata, Creator expiry, and Publication status and expiry. It does not
include local-only Artifacts. Access session policy is independent of Creator
and Public expiry. Synced cloud data remains until explicit deletion. The
inventory can rotate Creator links, manage Publication, issue adoption or
reconnect codes, export Legacy content, and explicitly delete cloud copies.

**Private R2**
The Worker-mediated store for exact synchronized file bytes and cloud
manifests. The bucket is not public. D1 holds relational metadata, hashes,
capability hashes, lifecycle state, and inventory data.

**Legacy Artifact**
A source-string cloud Artifact created before local Revisions became canonical.
It remains readable but read-only only during the migration window. Its private
access expires 30 days after one stable migration timestamp, and its public
links expire after 7 days. Export and local adoption create a separate local
Artifact; the first later Sync creates a new cloud identity.

**Reconnect recovery**
An Access-authenticated inventory action that issues a single-use reconnect
code valid for 10 minutes. `artifact_reconnect` validates local identity and
synced Revision metadata, then replaces only the Owner credential. It does not
rotate Creator access or Publication and does not alter local files.

## Explicit boundaries

- Local create, import, finalize, preview, and revise do not contact Cloudflare.
- Sync is never automatic and does not select a Publication Revision or duration.
- Public and Creator file delivery is Worker-mediated from private R2.
- Remote limits are 25 MiB per file and 100 MiB per Revision after ignore
  evaluation. They do not limit local history. Legacy retains a separate 1 MiB
  UTF-8 source limit.
- Panes does not stage, commit, branch, revert, rewrite Git metadata, perform
  automatic Git actions, host backend services, publish a package, or require a
  Panes skill or slash command.
