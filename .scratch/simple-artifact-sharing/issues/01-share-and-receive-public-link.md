# 01: Share and receive the Public link

**What to build:** Let a creator publish the selected finalized Revision through one confirmed Share action, then immediately copy or open the resulting Public link without visiting Inventory.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [x] A new share uses the selected finalized Revision and defaults to 7 days.
- [x] Existing first-upload permission and explicit public-sharing confirmation remain required.
- [x] A successful share returns the Public URL, selected Revision, and expiry to the Creator view.
- [x] Creator exposes working Copy link and Open link actions for the new share.
- [x] Public-token plaintext remains absent from manifests, logs, analytics, and unauthenticated responses.
- [x] Plugin, Worker HTTP, and Creator UI tests cover the complete flow.
