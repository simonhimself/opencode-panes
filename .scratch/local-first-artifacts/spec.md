# Local-First Artifacts

Status: ready-for-agent

## Problem Statement

OpenCode Panes currently treats an artifact as a source string that is uploaded to Cloudflare immediately. The plugin accepts only six predefined renderer types, stores no local source, and depends on permanent capability URLs for private and public access. This prevents the creator from using normal project files as the canonical artifact, building unrestricted multi-file prototypes, reviewing them locally before upload, and understanding or controlling everything retained on Cloudflare.

The creator wants Panes to feel like Claude Artifacts while remaining native to an OpenCode project. Asking for an artifact should create a browser-side prototype in the project, return a working local preview link, preserve visible local revisions, and upload nothing until explicitly requested. Cloud synchronization and public publication must remain separate. Remote inventory, access expiry, and deletion must be manageable without introducing a general deployment platform or multi-user account system.

## Solution

Panes will make the project filesystem canonical. Each artifact will live under the current Git worktree's artifact root, contain visible numbered revision directories, and declare a validated direct-browser or Panes-renderer Preview entry for each Revision. The plugin will prepare a Draft, allow the model to create arbitrary files with normal OpenCode filesystem tools, validate the Draft through a loopback preview server, finalize it as the next immutable Revision, and return the Local preview URL in the conversation. No cloud request occurs during creation or revision.

An explicit Sync uploads every unsynced revision as private byte-preserving R2 objects with D1 metadata. Publishing first completes that sync, then opens an expiring creator link where the human selects exactly one revision and a publication duration. Only that selected revision becomes public. A Cloudflare Access-protected Cloud inventory will show all synced artifacts and publication history, support recovery and deletion, and remain separate from frictionless creator and public links.

## User Stories

1. As a creator, I want an artifact request to create files inside my current project, so that the prototype belongs to the project rather than a remote service.
2. As a creator, I want every project artifact under one predictable artifact root, so that I can find prototypes without a Panes inventory UI.
3. As a creator, I want each artifact in its own directory, so that related files and revisions remain grouped.
4. As a creator, I want revisions represented by visible numbered directories, so that I can inspect their files directly.
5. As a creator, I want earlier revisions left unchanged, so that later iteration does not destroy reviewed work.
6. As a creator, I want unfinished model attempts kept as a draft, so that failed validation does not pollute revision history.
7. As a creator, I want only validated work promoted from draft to revision, so that every presented revision has a working preview.
8. As a creator, I want Panes to return a local preview URL in the OpenCode session, so that I can review the result immediately.
9. As a creator, I want each presented revision to receive its own reviewable preview, so that feedback produces a clear next revision.
10. As a creator, I want the preview link to serve multi-file prototypes correctly, so that CSS, JavaScript, modules, images, and fonts behave consistently.
11. As a creator, I want local preview behavior to match cloud rendering, so that a validated prototype does not break after sync.
12. As a creator, I want local preview traffic restricted to my machine, so that artifact code is not exposed on my network.
13. As a creator, I want the preview server to be temporary, so that local files do not depend on a long-running service.
14. As a creator, I want to reopen a local revision through Panes later, so that an expired local preview URL does not affect the files.
15. As a creator, I want the model to generate any files it needs locally, so that Panes does not constrain creative prototype implementation.
16. As a creator, I want static HTML, SVG, Markdown, Mermaid, code, and framework prototypes supported, so that the current artifact range remains available.
17. As a creator, I want framework projects built locally before finalization, so that Panes publishes browser-ready output rather than acting as an application host.
18. As a creator, I want each revision to declare one preview entry, so that Panes knows what to validate and open without restricting supporting files.
19. As a creator, I want unpreviewable drafts to remain local and unsynced, so that broken content never reaches Cloudflare.
20. As a creator, I want external network access blocked by default, so that generated prototypes remain safely sandboxed.
21. As a creator, I want to approve explicit external domains when a prototype needs them, so that network access is deliberate and reviewable.
22. As a creator, I want Panes to import an existing file, so that prior HTML, SVG, documents, and mockups can become artifacts.
23. As a creator, I want Panes to import an existing directory, so that multi-file prototypes can enter the same workflow.
24. As a creator, I want imports copied into the project artifact root, so that imported artifacts become self-contained project files.
25. As a creator, I want Panes to ask before deleting an imported source, so that importing cannot silently destroy the original.
26. As a creator, I want a simple source-and-filename shortcut for one-file artifacts, so that trivial generation remains convenient.
27. As a creator, I want Panes to find project artifacts in a new OpenCode session, so that iteration does not depend on conversation memory.
28. As a creator, I want Panes to ask when an artifact name is ambiguous, so that the agent never revises the wrong prototype.
29. As a creator, I want abandoned drafts detected on the next operation, so that I can resume or discard them explicitly.
30. As a creator, I want normal Git workflows to track artifact files, so that Panes does not stage or commit on my behalf.
31. As a creator, I want artifact metadata committed without credentials, so that identity and revision structure travel safely with the repository.
32. As a creator, I want no cloud upload during creation or revision, so that local work stays private until I choose otherwise.
33. As a creator, I want Sync to upload every unsynced revision, so that the private cloud viewer has complete history.
34. As a creator, I want byte-identical cloud files, so that synchronization never transforms source or binary assets.
35. As a creator, I want interrupted uploads hidden, so that the cloud never exposes a partial revision.
36. As a creator, I want failed Sync to leave finalized local revisions untouched, so that network errors cannot damage local work.
37. As a creator, I want reasonable remote size limits without local limits, so that Cloudflare remains protected without constraining generation.
38. As a creator, I want secrets, dependency trees, ignored files, and unsafe symlink targets excluded from Sync, so that accidental uploads are prevented.
39. As a creator, I want Sync to return a creator link, so that I can inspect all cloud revisions and manage publication.
40. As a creator, I want creator links to open without login, so that routine artifact review stays frictionless.
41. As a creator, I want creator links to expire after 30 days, so that old bearer capabilities do not live forever.
42. As a creator, I want a fresh creator link from the plugin when one expires, so that expiry does not block ongoing work.
43. As a creator, I want only one active creator link per artifact, so that rotating access invalidates the previous link.
44. As a creator, I want creator links to view revisions and publish or unpublish, so that the existing creator workflow remains familiar.
45. As a creator, I want creator links unable to delete cloud artifacts, so that a leaked link cannot perform permanent deletion.
46. As a creator, I want Publish to sync all unsynced revisions first, so that the creator viewer is complete before publication.
47. As a creator, I want Publish from OpenCode to open the creator viewer, so that the model never guesses which revision to expose.
48. As a creator, I want to select the public revision myself, so that earlier drafts remain private.
49. As a creator, I want publication durations of 1, 7, or 30 days with 7 days as the default, so that sharing is temporary by default.
50. As a creator, I want publishing another revision to revoke the previous public link, so that one artifact has one active publication.
51. As a creator, I want explicit Extend, Unpublish, and Republish actions, so that publication lifetime never changes silently.
52. As a creator, I want publication expiry and creator-link expiry independent, so that private management and public sharing follow different lifecycles.
53. As a public viewer, I want an expired link to show a clear status message, so that I know the link ended rather than the site failing.
54. As a public viewer, I want access only to the selected revision and its assets, so that private and later revisions remain undisclosed.
55. As a public viewer, I want Preview and Files views, so that I can interact with the prototype and inspect its published source.
56. As a public viewer, I want to download the selected multi-file revision as a ZIP, so that the published prototype is portable.
57. As a public viewer, I do not want directory listing, so that only known revision files are reachable.
58. As the cloud operator, I want one authenticated Cloud inventory, so that I can see everything stored on Cloudflare.
59. As the cloud operator, I want the Cloud inventory grouped by project, so that artifacts remain associated with their originating work.
60. As the cloud operator, I want to see revision count, storage size, last sync, creator-link state, and publication state, so that remote usage is understandable.
61. As the cloud operator, I want active public URLs visible and copyable, so that I can recover shared links.
62. As the cloud operator, I want expired and revoked publication history retained as metadata, so that prior sharing remains auditable.
63. As the cloud operator, I want to rotate creator links, so that private bearer access can be invalidated immediately.
64. As the cloud operator, I want to extend, unpublish, or republish selected revisions, so that remote sharing is centrally manageable.
65. As the cloud operator, I want permanent cloud deletion to require confirmation, so that destructive action is deliberate.
66. As the cloud operator, I want cloud deletion to revoke publications and remove private revisions without touching local files, so that the project remains canonical.
67. As the cloud operator, I want the dashboard restricted to my approved email through Cloudflare Access, so that global controls are strongly authenticated.
68. As a creator, I want a one-time reconnect code from the Cloud inventory if an owner credential is lost, so that a repository can reattach to its existing cloud artifact.
69. As a creator, I want private synced artifacts retained until explicit deletion, so that access-link expiry does not erase remote history.
70. As a creator, I want old cloud-first artifacts marked as legacy, so that their different guarantees are visible.
71. As a creator, I want legacy artifacts readable but not revisable through the old source-string flow, so that all new iteration follows the local-first model.
72. As a creator, I want to export and adopt a legacy artifact locally, so that I can continue editing it under the new workflow.
73. As a creator, I want existing legacy creator and public links to receive migration expiry dates, so that no historical capability remains permanent.
74. As a maintainer, I want the plugin alone to drive the workflow, so that no separately installed skill is required.
75. As a maintainer, I want focused but minimal plugin tools, so that models follow the workflow without an overengineered interface.
76. As a maintainer, I want current status-page styling reused for expiry, so that new access states remain visually consistent.

## Implementation Decisions

### Local artifact model

- The project filesystem is canonical. Cloudflare is an optional synchronized copy and sharing surface.
- The artifact root is `<git-worktree>/artifacts/`. When no worktree exists, it is `<session-directory>/artifacts/`. There is no alternate-root configuration in the initial implementation.
- Each artifact uses `artifacts/<slug>/artifact.json`, a temporary `draft/`, and contiguous finalized directories named `v1/`, `v2/`, and so on. A slug collision requires explicit selection or a different slug; Panes never merges artifact directories implicitly.
- A revision is immutable by workflow. Preparing a revision copies the latest finalized revision into a temporary draft. Finalization uses a recoverable promotion protocol to move the validated draft to the next number and then update the manifest.
- The manifest records a schema version, stable project and artifact identifiers, slug, title, optional descriptive kind, finalized revisions, per-revision preview entries, file paths, hashes, byte sizes, media types, approved network origins, and cloud mapping identifiers. It never stores owner credentials, creator tokens, public tokens, reconnect codes, or admission secrets.
- Manifest paths use normalized relative POSIX paths. Absolute paths, parent traversal, control characters, duplicate normalized paths, and platform-specific aliases that collide are rejected.
- The manifest is the revision ledger. Finalized numbering must be contiguous. Missing directories, unexpected directories, changed hashes, or deleted files are reported without automatic repair. A Git checkout can restore a valid state, after which Panes rescans normally.
- Immutability is enforced at Panes boundaries rather than by filesystem permissions. If a finalized revision changes, preview and Sync refuse it. The creator may restore it or copy the changed files into a new draft and restore the earlier revision.
- Empty files and nested directories are valid. Empty directories are represented in the manifest so export and ZIP can preserve them. Browser runtime does not rely on executable permission bits, but import and ZIP preserve portable file mode metadata where available.
- Projects use their normalized Git remote as stable identity when available and a repository-stored generated identifier otherwise. The directory name is display metadata, not identity.
- Panes does not stage, commit, revert, rewrite Git metadata, or modify unrelated project files.
- Panes scans project manifests to resolve artifacts across sessions. Ambiguous names require user selection.
- Existing drafts are never overwritten. A later operation asks whether to resume or discard them.
- Mutating operations use an artifact-scoped lock and idempotency key. A live lock blocks concurrent prepare, finalize, import, or Sync. An abandoned lock is recoverable only after its owning process is gone; recovery preserves the draft, finalization journal, and any upload checkpoint.
- Finalization is recoverable rather than cross-file atomic. While holding the lock, Panes writes and durably flushes a journal containing the target Revision number, Preview entry, approved origins, and file hashes; renames `draft/` to `vN/` on the same filesystem; atomically replaces `artifact.json` through a temporary file; then removes the journal. Recovery completes or rolls back the recorded phase after verifying hashes, and never exposes two Revisions with the same number.

### Plugin workflow

- The plugin remains sufficient; no Panes skill is required initially. Model adherence will be validated across supported models before reconsidering a skill.
- Keep the tool surface focused and minimal. The initial capabilities are prepare, finalize, import, and sync. Opening the Cloud inventory does not require a separate tool.
- Prepare supports creating a new artifact, preparing the next revision, or reopening a finalized local revision for preview without creating a draft. It returns the selected local path and operation state to the model.
- Normal OpenCode filesystem tools create and modify arbitrary draft files. The plugin does not constrain the draft to a renderer enum or serialize the artifact as one source string.
- A convenience input may seed a simple one-file draft from source plus a filename. It still follows the same validation and finalization rules.
- Finalize requires a normalized relative entry path, a Preview adapter, and the Draft's requested network origins. It starts the internal Local preview, validates the entry under the artifact security policy, runs the recoverable promotion protocol, and returns a Revision-specific Local preview URL.
- If requested origins are not already approved for this Finalize attempt, Finalize returns an approval-required result containing the normalized origin list and a bound confirmation nonce. It performs no promotion. After the agent obtains user approval, a second Finalize call presents that nonce and the exact approved set; any changed Draft or origin set invalidates the nonce.
- Finalize and Local preview make no Cloudflare request. Cloud identity and credentials are created only by explicit Sync.
- Import accepts a file or directory, copies it through a temporary directory, atomically installs a complete Draft, and follows the same Finalize flow. Destination collisions require user selection. A successful copy returns a short-lived verification receipt bound to the source path, source hashes, destination Artifact, and import operation.
- Removing imported source is a second Import operation using the verification receipt after the user explicitly confirms deletion. Panes immediately re-hashes the source, refuses deletion if the receipt expired or any source state changed, and consumes the receipt on success. Normal filesystem tools do not perform this Panes-managed cleanup step.
- Sync uploads all unsynced finalized Revisions. Its `openCreatorAfterSuccess` option defaults to false. Every successful Sync returns the Creator link and Cloud inventory address; when the option is true, the plugin also attempts to open the Creator workspace and still returns the URL if browser launch fails.
- A natural-language request to publish invokes Sync with `openCreatorAfterSuccess: true` and waits for it to complete. The human then selects the Revision and duration, and the Creator viewer submits the Publication. Sync failure stops the sequence, and the plugin never selects or submits a Publication itself.

### Preview and runtime contract

- Panes targets browser-side prototypes, not backend services, databases, server processes, or general deployments.
- Local files are unrestricted. A finalized Revision declares one Preview entry containing a normalized relative path and one adapter mode.
- A `browser` adapter serves the entry directly and supports browser-native entries such as HTML, SVG, and built framework output. A `renderer` adapter names a supported Panes renderer for Markdown, Mermaid, code, or the existing single-file React format. Renderer adapters generate a sandboxed runtime wrapper at request time without changing or storing transformed source bytes.
- Framework source is allowed, but frameworks outside a supported renderer adapter must be built locally into a browser entry before Finalize. Panes does not run framework servers in Cloudflare.
- Finalize validates the Draft through an internal preview but returns a URL only after recoverable promotion completes, so the result presented in chat is `v1` or the next finalized Revision rather than an unstable Draft.
- The local preview server binds only to the IPv4 loopback interface, asks the operating system for an available port, uses unguessable revision-specific paths, serves correct MIME types, and stops with the local Panes process. URLs are process-local capabilities and are not durable across restarts; Prepare can reopen a finalized revision and issue a new URL.
- Preview path resolution occurs against an immutable file snapshot and rejects traversal, aliases, and symlink races before serving content.
- Local preview and cloud rendering share sandbox, content-security, routing, MIME, and network policies so validation reflects publication behavior.
- External network access is denied by default. The Finalize request declares the Draft's requested network origins separately from the Artifact's finalized metadata. Requested origins have no effect until the approval handshake succeeds.
- Approved network entries are immutable per-Revision `http` or `https` origins stored with that Revision, not arbitrary CSP strings. Panes derives the relevant `connect`, image, media, font, style, and script directives and blocks unapproved redirect targets. WebSocket schemes (`ws` and `wss`) and all other schemes are unsupported initially and remain blocked even when the corresponding HTTP origin is approved.
- Simple files may still be opened directly by the user, but only the Panes HTTP preview is considered validated.

### Synchronization and storage

- R2 stores exact immutable file bytes. D1 stores relational metadata for projects, artifacts, revisions, revision files, credentials, creator-link expiry, publications, migration state, and dashboard queries.
- Local protected plugin state stores Owner credentials, synchronized hashes, and resumable upload checkpoints keyed by stable project and Artifact identifiers. Repository manifests contain only non-secret cloud identifiers and canonical local Revision metadata; Sync status is not written into finalized Revision content.
- D1 source-text bodies are not the storage model for new revisions.
- Each uploaded file is identified by raw-byte SHA-256 and byte size. Cloud metadata is committed only after every required file is present and verified.
- A failed or interrupted upload may leave temporary R2 objects eligible for cleanup, but it must not create a visible synced revision.
- Temporary upload objects use a separate namespace and creation timestamp. Scheduled cleanup removes uncommitted objects after a conservative grace period while never deleting objects referenced by a committed revision.
- Sync uploads every unsynced finalized revision in version order. Already verified files may be reused by content hash.
- Canonical `artifact.json` remains local and continues to describe every local Revision file, including files excluded from Sync. Panes derives a separate cloud manifest containing only non-secret Artifact metadata, synced Revisions, approved origins, Preview entries, and the exact files selected for upload. Ignored filenames, paths, hashes, and sizes never appear in the cloud manifest.
- Sync uploads the derived cloud manifest plus selected finalized Revision contents. The cloud manifest cannot be ignored. Sync excludes Drafts, `.env` files, Git internals, dependency directories, local build caches, and ignored Revision files. Neither canonical `artifact.json` nor the local `.panesignore` file is uploaded.
- `.panesignore` uses ordered Gitignore-style patterns relative to the Artifact root. The last matching user pattern wins, including negation, but no pattern can re-include mandatory secret, Git, dependency, Draft, or build-cache exclusions. Ignore rules apply only to Revision content; excluded files do not count toward remote limits.
- Broken symlinks and symlinks escaping the revision are rejected. Internal symlinks are resolved once against the locked revision snapshot and uploaded as regular file bytes; the cloud format never serves a symlink.
- Initial remote limits are 25 MB per file and 100 MB per revision. These limits do not apply to local creation or revision history.
- Limits use raw file bytes after ignore evaluation. They replace, rather than supplement, the legacy 1 MiB source, 16-revision, and 2 MiB aggregate caps for local-first artifacts.
- Transactional visibility applies per revision. A multi-revision Sync may commit earlier revisions before a later revision fails. Retry resumes from the first uncommitted revision and never renumbers local revisions.
- Concurrent Sync requests first serialize through the local Artifact lock and then through a server-side cloud-Artifact transaction or lease. Replays with the same idempotency key return the existing committed Revision when all hashes match and reject conflicting content for an existing Revision number.
- Public and creator file delivery is mediated by the Worker from private R2 storage. Buckets are never public.

### Credentials and access

- Retain the current scoped credential model instead of introducing user accounts or an account-wide plugin credential.
- The existing creation admission key authorizes only first-Sync creation of a new cloud Artifact.
- A local Artifact has no cloud identity or Owner credential before first Sync. First Sync creates the cloud Artifact using a stable idempotency key, receives its cloud identifier and Owner credential, and uses a recoverable local checkpoint to durably write the non-secret mapping to `artifact.json` and the secret to protected global state before uploading Revisions. Retrying any interrupted checkpoint phase recovers the same creation result rather than creating a duplicate cloud Artifact.
- The owner credential persists until rotated or the cloud artifact is deleted. It is not a URL credential and has no repository representation.
- Each artifact has at most one active creator link. The creator link is a bearer capability with a fixed 30-day expiry.
- The current non-expiring workspace token remains only as a legacy credential during migration. New local-first owner credentials are not creator URLs, and new 30-day creator tokens cannot synchronize revisions.
- A valid creator link can read every synced revision and publish, extend, unpublish, or republish. It cannot permanently delete the artifact or access the Cloud inventory.
- Reusing a valid creator link does not extend it. Rotating it revokes the prior link and starts a new 30-day period.
- An expired or revoked creator link returns `410 Gone`, uses the existing status-page layout, and instructs the user to reopen through OpenCode or the Cloud inventory. Unknown tokens return `404 Not Found`.
- Capability URLs are returned only to the intended tool caller or viewer. Tokens are never stored in manifests or analytics, are redacted from structured logs and errors, and pages send `Referrer-Policy: no-referrer` plus non-cacheable response headers.
- Cloudflare Access protects only the Cloud inventory and administrative APIs. The allow policy admits `simonhimself@gmail.com`; creator and public routes remain outside Access. Administrative requests require a valid Access JWT for the configured audience, and unauthenticated API responses disclose no inventory metadata.
- The Cloud inventory can rotate a lost owner credential and issue a single-use, short-lived reconnect code. Redeeming the code stores the replacement credential locally and invalidates the previous owner credential. Codes are hashed at rest, expire without changing current credentials, and cannot be reused.

### Publication

- Synchronization and publication are distinct. Sync is private. Publication grants time-bounded public access.
- Publish is available only for fully synced Artifacts. OpenCode publish intent runs Sync to completion, opens or returns the Creator link, and stops there. The Creator viewer owns Revision and duration selection plus the Publication request.
- The human selects exactly one revision in the creator viewer. Only that revision and its asset files become publicly readable.
- Publication choices are 1 day, 7 days, or 30 days. Seven days is the default. Permanent publication is unavailable.
- One artifact has at most one active publication. Publishing a different revision revokes the active link and creates a new one.
- Publishing the same active revision does not silently extend expiry. Extension is an explicit action.
- Unpublish revokes the active public link without deleting private synced files.
- Republish after expiry or revocation creates a new public link.
- Publication times use server-generated UTC timestamps. Competing publish, extend, and revoke requests serialize so only the final committed publication is active.
- Expired or revoked public routes return `410 Gone` and use the established status-page component with an expiration-specific message and no private metadata. Unknown tokens return `404 Not Found`.
- Publication records remain as expired or revoked history in the Cloud inventory.
- Public URLs expose no directory listing and authorize file access only within their selected revision.

### Cloud inventory and viewer

- The Cloud inventory lists synced artifacts only. It has no knowledge of local-only artifacts and there is no local Panes inventory.
- Inventory groups artifacts by project and shows title, revision count, storage size, last sync, creator-link expiry, active publication, public expiry, and legacy state.
- Inventory actions include opening privately, rotating creator access, copying an active public URL, extending, unpublishing, republishing, recovering an owner credential, exporting legacy content, and permanently deleting the cloud copy.
- Permanent deletion requires confirmation, revokes all active links, removes D1 metadata and private R2 files when no longer referenced, and never modifies local project files.
- Creator view retains the revision selector. Public view contains only the selected revision.
- Multi-file revisions use Preview and Files tabs. Files provides a safely normalized file tree and syntax-highlighted text contents. Binary files show media type and size with a download action rather than unsafe inline decoding.
- Download streams the selected revision as `<artifact-slug>-vN.zip`, preserves empty directories and portable modes, and never includes credentials or cloud-only metadata. Public downloads include only the published revision. The existing 100 MB uncompressed revision limit bounds initial ZIP scope.
- An active Public token is stored in D1 as both a one-way lookup hash and AES-GCM ciphertext with a random nonce and encryption-key version. A versioned Worker secret encrypts and decrypts the ciphertext; normal public validation uses only the hash, while only the Access-protected Cloud inventory may decrypt the active token to reconstruct its Public link.
- Public-token plaintext and encryption keys never enter logs, analytics, manifests, or API responses other than the authorized Public-link result. Revocation or expiry deletes the recoverable ciphertext while retaining non-secret Publication history and the lookup hash needed for status responses. Key rotation preserves the version needed to decrypt still-active tokens.

### Legacy migration

- Existing cloud-first artifacts are classified as legacy and remain readable but read-only.
- Legacy artifacts appear in the Cloud inventory under a legacy grouping even though they have no project-local canonical directory.
- A migration timestamp is recorded once. Existing creator links expire 30 days after that timestamp and existing public links expire 7 days after it; rerunning migration never extends either date.
- Legacy export begins from an authenticated Cloud inventory action and returns an adoption payload for the plugin. The plugin writes a valid project Artifact with `v1` and the appropriate Preview adapter. Adoption creates a new local-first cloud Artifact identity on first Sync, leaving the read-only Legacy artifact and its history intact until explicit dashboard deletion. Further revision requires adoption; the old source-string update flow is not retained.
- Existing status and viewer components should be reused where their behavior remains valid.

## Testing Decisions

- Tests assert externally visible behavior: resulting project files, tool results, HTTP responses, stored bytes and metadata, rendered states, and user actions. They should not lock in helper structure, internal call order, generated SQL text, or incidental component composition.
- Use three existing high-level seams rather than introducing a cross-runtime end-to-end framework.
- The plugin-tool seam invokes the registered tools against temporary Git worktrees and controlled preview/API servers. It covers artifact-root selection, draft preparation, revision promotion, import, source convenience, manifest discovery, ambiguity, abandoned drafts, local preview URLs, domain approval, sync selection, and protection of unrelated files.
- Plugin tests verify that normal creation, Finalize, and revision make no Cloudflare request; Sync uploads every unsynced finalized Revision with a cloud manifest derived from the final upload set; ordinary Sync leaves the Creator workspace closed; publish intent stops on Sync failure and otherwise opens or returns the Creator link without guessing or submitting a Revision or duration; and no Git staging or commit occurs.
- Plugin tests verify exact raw bytes for text and binary files, including line endings, byte-order marks, final newlines, and non-UTF-8 content.
- Plugin security tests cover traversal attempts, absolute entry paths, escaping symlinks, ignored secrets, dependency directories, oversized remote files, malformed manifests, modified finalized revisions, and creator/owner credential redaction.
- Local preview tests exercise direct browser and generated renderer adapters, multi-file assets, module scripts, MIME types, Revision-specific URLs, loopback-only binding, process shutdown, sandbox behavior, requested-origin approval and nonce invalidation, approved and denied external origins, each journal crash point, and failures that leave a recoverable Draft or promotion.
- The Worker HTTP seam extends the existing Worker integration suite with local D1 and R2 bindings. It covers project/artifact creation, idempotent file upload, hash and size verification, transactional revision commit, complete-history sync, authorization boundaries, and cleanup of uncommitted objects.
- Worker tests cover creator-link issuance, reuse, rotation, fixed expiry, expired responses, creator capabilities, prohibited deletion, owner recovery, and invalidation of replaced credentials.
- Worker tests cover selected-revision publication, asset scoping, one active publication, explicit extension, replacement, unpublish, republish, 1/7/30-day expiry, recoverable active URLs, and history retention.
- Worker tests cover Cloud inventory authorization independently from creator/public capabilities. Access edge configuration receives a separate deployment acceptance check for the exact allowed email and protected paths.
- Worker migration tests apply new migrations to existing fixtures, classify legacy artifacts, assign migration expiry, preserve readable revisions, prohibit legacy updates, export source, and delete without orphaning storage.
- The viewer-interaction seam extends existing React app tests. It covers creator revision selection, human publication controls, Files navigation, syntax display, ZIP download, public single-revision isolation, inventory grouping/actions, reconnect workflow, and legacy labels.
- Viewer tests reuse the existing entry/status component and distinguish expired, revoked, malformed, missing, and failed API states without disclosing private metadata.
- Manual acceptance verifies a real OpenCode conversation for create, review, revise, import, Sync, creator-link renewal, publication, expiry, dashboard login, recovery, and deletion. It also checks at least the primary supported model and one additional provider before declaring workflow reliability.
- Full cross-runtime browser automation is not required by this spec. It remains a possible later hardening seam if the three approved seams miss integration failures.

## Out of Scope

- Backend services, databases, server-side application runtimes, containers, and general deployment hosting.
- A Panes local dashboard, local inventory, or local version-selection UI.
- Automatic Git staging, commits, branches, or source-control recovery.
- Automatic background synchronization or upload during create, revise, preview, or finalize.
- Model-selected public publication without explicit human revision and duration selection.
- Permanent creator or public bearer links.
- Multi-user accounts, organizations, roles, or public plugin distribution work.
- A required Panes skill or slash command.
- Panes-managed framework dependency installation or cloud builds.
- Cloud synchronization of drafts, unpreviewable artifacts, ignored files, credentials, dependency directories, or escaping symlinks.
- Public access to multiple revisions from one publication.
- Editing legacy artifacts through the old source-string API.
- Collaboration, concurrent multi-author revision merging, comments, or approval workflows.
- Automatic deletion of local artifacts when cloud copies are deleted.
- A new full cross-runtime end-to-end test harness.

## Further Notes

- The design intentionally copies the experience of Claude Artifacts rather than its internal implementation: natural-language creation, immediate visual review, iteration, and deliberate publication.
- Local creative freedom and cloud previewability are separate guarantees. Panes does not restrict what the model creates in a draft, but only validated browser-side revisions can finalize and sync.
- The current plugin already has useful credential separation. The redesign should evolve those boundaries rather than replace them with broader credentials.
- The current viewer already contains revision selection, creator/public separation, sandboxing, source display, and reusable status states. The redesign should deepen those modules for multi-file revisions and expiry rather than replace them wholesale.
- The current D1 text revisions and permanent capability links are legacy behavior. New schema changes must use additive migrations and preserve a rollback path until migration acceptance passes.
- Cloudflare Access protects administrative inventory only. Frictionless creator and public URLs remain deliberate product behavior with bounded lifetimes.
