# 04: Discover, reopen, and recover local Artifacts

**What to build:** Let a later OpenCode session find project Artifacts from their manifests, reopen a finalized Revision with a fresh Local preview, and recover safely from abandoned Drafts or interrupted operations.

**Blocked by:** 03: Finalize an immutable Revision with a Local preview

**Status:** ready-for-agent

- [ ] Artifact discovery scans valid manifests under the project artifact root without relying on conversation memory.
- [ ] Exact identifiers and unambiguous names resolve directly; ambiguous names return choices and perform no mutation.
- [ ] A finalized Revision can be reopened with a new process-local Preview URL without creating a Draft.
- [ ] An abandoned Draft is reported and requires an explicit resume or discard decision.
- [ ] A live artifact lock blocks concurrent mutation, while a stale lock is recoverable only after its owning process is gone.
- [ ] Recovery preserves Draft contents and resumable operation state, and resolves a finalization journal according to its recorded phase and verified hashes.
- [ ] Git checkout restoration is recognized on the next scan without Panes attempting automatic repair.
