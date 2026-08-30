# 02: Update an active share in place

**What to build:** Let a creator update an active share to a newer synced Revision while colleagues continue using the Public URL they already received.

**Blocked by:** 01: Share and receive the Public link.

**Status:** ready-for-human

- [x] Updating an active share changes the selected Revision without changing its Public token or URL.
- [x] Updating an active share preserves its existing expiry unless the creator explicitly chooses another duration.
- [x] Creator presents Update shared version when a newer Revision is selected.
- [x] The original Public URL renders the newer Revision after the update.
- [x] Expired, revoked, or explicitly rotated shares still receive a new Public token when shared again.
- [x] Worker HTTP, Creator UI, and end-to-end tests cover stable-link updates and inactive-share behavior.
