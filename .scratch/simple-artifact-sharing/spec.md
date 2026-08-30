# Simple Artifact Sharing

Status: ready-for-human

## Problem Statement

Sharing an Artifact currently exposes too much of Panes' internal lifecycle.
Publishing does not immediately show the Public link, so creators must recover
it from Inventory. Publishing a newer Revision replaces the Public token and
breaks the URL colleagues already received. Creator and Inventory then surround
these basic tasks with internal and recovery controls.

The first simplification should fix the sharing journey, not redesign the whole
product. A creator should be able to share, copy the link, and later update the
shared content without breaking that link.

## Solution

Make Share the single normal publishing action. It uses the selected finalized
Revision, defaults to 7 days for a new share, asks for explicit confirmation,
and returns the Public link immediately.

When an active share is updated to another synced Revision, preserve its Public
URL and existing expiry. Creator shows one contextual primary action plus Copy
link and Open link. Inventory puts current Artifacts first and hides exceptional
controls behind Manage. A Public link opens directly to the Artifact preview.

Existing security and lifecycle boundaries remain in place. This spec changes
the normal interaction, not the underlying Artifact model.

## User Stories

1. As a creator, I want Share to use the selected finalized Revision, so that I do not have to sequence internal lifecycle operations.
2. As a creator, I want a new share to default to 7 days, so that the common choice requires no configuration.
3. As a creator, I want one explicit confirmation before public access begins, so that sharing cannot happen accidentally.
4. As a creator, I want the Public link immediately after sharing, so that I can send it without visiting Inventory.
5. As a creator, I want Copy link and Open link beside an active share, so that I can use and verify it directly.
6. As a creator, I want updating an active share to preserve its URL, so that existing messages and bookmarks continue to work.
7. As a creator, I want updating an active share to preserve its expiry, so that changing content does not silently change access duration.
8. As a creator, I want one contextual sharing action, so that Creator does not present several overlapping lifecycle controls.
9. As a creator, I want current Artifacts before Legacy history in Inventory, so that active work is easier to find.
10. As a creator, I want exceptional recovery and destructive controls behind Manage, so that routine actions remain prominent.
11. As a colleague, I want a Public link to open directly to the Artifact preview, so that Panes does not obstruct the content.
12. As an operator, I want existing capability, immutability, expiry, and recovery safeguards preserved, so that simpler UX does not weaken security.

## Implementation Decisions

- The first Share uses the selected finalized Revision and defaults to 7 days.
- Share still requires explicit public-sharing confirmation and existing first-upload permission.
- Successful publication responses include the Public URL, selected Revision, and expiry.
- A Creator-authorized view may recover the active Public URL. Public-token plaintext must remain absent from manifests, logs, analytics, and unauthenticated responses.
- Updating an active share changes its selected synced Revision without changing its Public token, URL, or expiry.
- Expired, revoked, or explicitly rotated shares receive a new Public token when shared again.
- Creator exposes one state-based primary action: Share this version, Update shared version, or Share again. Active shares also expose Copy link and Open link.
- Inventory shows current Artifacts before collapsed Legacy history. Recovery, rotation, adoption, reconnect, and deletion remain available behind Manage.
- Public view opens on the preview. Files, download, expiry, and safety details remain secondary.
- Existing capability scopes, immutable Revisions, private Sync, iframe isolation, expiry, and destructive confirmations do not change.

## Testing Decisions

- Plugin tests verify one confirmation, the 7-day default, and immediate Public-link return for the normal Share action.
- Worker HTTP tests verify first publication, active-share Revision update with the same token and expiry, and new-token creation after expiry or revocation.
- Creator UI tests verify the correct contextual action and direct Copy/Open behavior for inactive, active, updated, expired, and revoked states.
- Inventory UI tests verify that current Artifacts precede collapsed Legacy history and exceptional controls are hidden behind Manage.
- Public UI tests verify that a valid link opens directly to the preview.
- One end-to-end test shares an Artifact, opens its Public URL, publishes a newer Revision, and confirms the same URL now renders the newer Revision.
- Existing authorization, immutable Revision, expiry, recovery, deletion-confirmation, and raw-byte-preservation tests remain green.

## Out of Scope

- Multi-user accounts, team roles, comments, approvals, or collaborative editing.
- Preview adapter or entry-file inference.
- Combining or replacing Prepare, Import, Finalize, and Sync tools.
- Search, filtering, URL-backed UI state, or a complete Inventory redesign.
- Broad terminology, accessibility, mobile, file-tree, or visual-system redesign.
- Redesigning Stop sharing, link rotation, recovery, adoption, reconnect, or deletion behavior.
- Making Public links permanent or publishing without confirmation.
- Removing or changing the renderer, sandbox, capability, or Artifact lifecycle models.
- Package publication, remote deployment, or migration execution as part of this spec.

## Further Notes

- This spec intentionally revises the requirement to recover a normal Public link through Inventory.
- A valid Creator capability may receive the active Public URL because it can already replace that link. Public-token plaintext remains limited to authorized Creator and Access-protected Inventory responses.
- “Stable Public URL” means stable while an active Publication is updated to another synced Revision. Explicit revocation, expiry, or rotation may invalidate it.
- Broader simplification findings remain valid follow-up candidates, but they should not block this release.
