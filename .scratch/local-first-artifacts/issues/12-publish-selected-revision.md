# 12: Publish one selected Revision with explicit expiry

**What to build:** Let the human choose one synced Revision and expose it through one time-bounded Publication. Publication remains distinct from Sync and changes only through explicit publish, extend, unpublish, or republish actions.

**Blocked by:** 11: Open synced Revisions in the Creator workspace

**Status:** ready-for-agent

- [ ] OpenCode publish intent invokes Sync with `openCreatorAfterSuccess` enabled and stops without opening or publishing when Sync fails.
- [ ] Ordinary Sync leaves `openCreatorAfterSuccess` disabled and returns the same Creator URL without launching it.
- [ ] After successful Sync, the plugin opens the returned Creator link or returns it for manual opening if browser launch fails.
- [ ] The plugin never selects a Revision or duration and never submits the Publication; those actions occur only in the Creator workspace.
- [ ] The human selects exactly one synced Revision and a duration of 1, 7, or 30 days; 7 days is selected by default.
- [ ] One Artifact has at most one active Publication, and publishing another Revision revokes and replaces the active public link.
- [ ] Publishing the same active Revision does not silently extend it.
- [ ] Extend, Unpublish, and Republish are explicit actions with server-generated UTC expiry timestamps.
- [ ] Competing publication mutations serialize so only the final committed state is active.
- [ ] An active Public token is indexed by a one-way hash and stored recoverably only as AES-GCM ciphertext with a random nonce and encryption-key version.
- [ ] Creator-link expiry and Publication expiry remain independent.
- [ ] Expired and revoked Publication records remain available as private history without keeping public access active.
