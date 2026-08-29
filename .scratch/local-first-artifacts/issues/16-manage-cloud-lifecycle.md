# 16: Manage cloud lifecycle from the inventory

**What to build:** Let the authenticated cloud operator rotate access, manage Publications, and permanently delete a private cloud copy. Permanent actions require confirmation and never alter the canonical local Artifact.

**Blocked by:** 15: Build the authenticated Cloud inventory

**Status:** ready-for-agent

- [ ] The inventory can rotate a Creator link, immediately revoke the previous token, and display the new fixed 30-day expiry.
- [ ] The inventory can Extend, Unpublish, or Republish an eligible Revision with the same Publication rules as the Creator workspace.
- [ ] Link and Publication mutations update inventory state without exposing raw tokens in logs, analytics, or errors.
- [ ] Permanent cloud deletion requires explicit confirmation that identifies the Artifact and consequence.
- [ ] Deletion revokes Creator and public links, removes private Revision metadata, and removes object bytes only when no committed reference remains.
- [ ] Deletion is idempotent and safely resumes after partial storage cleanup.
- [ ] Local files are never read, changed, or deleted by a Cloud inventory action.
- [ ] Retention tests prove that link expiry, revocation, and local deletion do not remove cloud data without this explicit action.
