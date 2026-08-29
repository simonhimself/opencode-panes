# 17: Recover an Owner credential with a reconnect code

**What to build:** Let the authenticated cloud operator reconnect a local Artifact after its Owner credential is lost. Recovery uses one short-lived, single-use code and replaces the compromised credential without broadening Creator-link authority.

**Blocked by:** 15: Build the authenticated Cloud inventory

**Status:** ready-for-agent

- [ ] The inventory issues a short-lived reconnect code for a selected local-first Artifact after explicit confirmation.
- [ ] Only a hash of the reconnect code is retained, and the plaintext is shown only at issuance.
- [ ] The plugin redeems the code, verifies project and Artifact identity, and stores the replacement Owner credential in protected local state.
- [ ] Successful redemption invalidates the previous Owner credential and the reconnect code.
- [ ] Expired, reused, malformed, or wrong-Artifact codes fail without changing current credentials.
- [ ] Recovery does not rotate Creator or public links unless separately requested.
- [ ] No reconnect code or Owner credential enters the project manifest, Artifact files, logs, or tool errors.
