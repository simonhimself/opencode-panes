# 15: Build the authenticated Cloud inventory

**What to build:** Give the cloud operator one authenticated inventory of everything synchronized to Cloudflare. It groups Artifacts by project and shows storage, Sync, Creator-link, and Publication state without exposing administrative controls through bearer links.

**Blocked by:** 10: Harden Sync recovery and Creator-link lifecycle; 12: Publish one selected Revision with explicit expiry

**Status:** ready-for-agent

- [ ] Cloudflare Access admits only `simonhimself@gmail.com` to inventory pages and administrative APIs.
- [ ] Administrative requests require a valid Access identity and configured audience; failed authentication reveals no inventory metadata.
- [ ] Inventory groups synced Artifacts by stable project identity and has no dependency on local-only Artifacts.
- [ ] Each Artifact shows title, Revision count, storage size, last Sync, Creator-link state and expiry, active Publication, public expiry, and active public URL when available.
- [ ] Active public URLs are recoverable and copyable only from the authenticated inventory.
- [ ] Inventory reconstructs an active Public link by decrypting its versioned AES-GCM ciphertext with a Worker secret; unauthorized routes cannot request decryption.
- [ ] Publication expiry or revocation removes recoverable ciphertext while preserving non-secret history and status lookup data.
- [ ] Creator and public routes remain outside Access and retain their scoped capability behavior.
- [ ] Inventory loading, empty, partial-error, and unauthorized states have viewer interaction coverage.
- [ ] Access and binding configuration passes a deployment dry run.
