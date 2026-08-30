# 02: Prepare a project Artifact Draft

**What to build:** Let the creator start a new local Artifact or its next Draft inside the current project. The operation establishes the canonical manifest and writable Draft without contacting Cloudflare or changing Git state.

**Blocked by:** 01: Expand local-first contracts beside legacy contracts

**Status:** ready-for-agent

- [ ] A Git worktree uses its `artifacts/` directory, while a non-Git session uses the session directory's `artifacts/` directory.
- [ ] A new Artifact receives a stable identifier, safe slug, non-secret manifest, and temporary Draft directory.
- [ ] Preparing a revision copies the latest finalized Revision into Draft without modifying any finalized Revision.
- [ ] Slug collisions and an existing Draft produce an explicit choice instead of an implicit overwrite or merge.
- [ ] Project identity uses a normalized Git remote when available and a stored generated identifier otherwise.
- [ ] The operation makes no network request and never stages, commits, rewrites Git metadata, or modifies unrelated files.
- [ ] Repeating the same idempotent request returns the existing operation state rather than creating duplicate Drafts.
- [ ] The prepare workflow works through the installed plugin alone and does not require a Panes skill or slash command.
