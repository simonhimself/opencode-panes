# 22: Update local-first documentation and supersede the old plan

**What to build:** Make the repository documentation describe the accepted local-first behavior, security boundaries, operating limits, and migration path. Remove or clearly supersede every remote-first instruction that would send an implementer or user down the obsolete source-string workflow.

**Blocked by:** 21: Validate real OpenCode conversations

**Status:** done

- [x] User documentation explains the canonical local layout, Draft and Revision lifecycle, Preview adapters, import, Local preview, explicit Sync, and human-controlled Publication.
- [x] Documentation distinguishes Owner credentials, Creator links, Publications, Public links, Cloud inventory access, and their independent expiry or retention rules.
- [x] Remote limits, `.panesignore`, the filtered cloud manifest, approved HTTP origins, unsupported WebSockets, private R2 storage, Access protection, deletion, and Owner recovery are documented accurately.
- [x] Documentation explains `openCreatorAfterSuccess`, the Import verification receipt, and encrypted recoverable Public tokens without exposing implementation secrets.
- [x] Legacy read-only behavior, migration expiry, inventory export, local adoption, and the new cloud identity are documented.
- [x] The old remote-first plan is removed or clearly marked as superseded wherever it conflicts with implemented behavior.
- [x] Documentation states that the installed plugin is sufficient and no Panes skill, slash command, package publication, backend hosting, or automatic Git operation is required.

Acceptance evidence: `README.md`, `CONTEXT.md`, `PROJECT_PLAN.md`, and the plugin README now describe the accepted local-first workflow and explicitly supersede remote-first mutation guidance. An independent accuracy review corrected capability-response scope, lazy expired-ciphertext cleanup, reconnect Creator availability, installer assets, Publication-history surfaces, origin approval, import deletion arguments, local Owner-state retention, and Git identity wording.
