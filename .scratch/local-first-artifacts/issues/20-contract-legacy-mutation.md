# 20: Contract the legacy source-string mutation path

**What to build:** Finish the migration by making all new creation and revision use project-local Artifacts. Remove the obsolete mutation surface and limits while retaining explicit read-only Legacy access and deletion.

**Blocked by:** 10: Harden Sync recovery and Creator-link lifecycle; 18: Migrate cloud-first Artifacts to read-only Legacy artifacts; 19: Export and adopt a Legacy artifact locally

**Status:** ready-for-agent

- [ ] The plugin no longer registers or documents the old source-string create/revise workflow for new work.
- [ ] New cloud Artifact creation occurs only through explicit Sync of a valid local Artifact.
- [ ] Legacy mutation endpoints are removed or return the documented read-only response without affecting Legacy reads.
- [ ] The obsolete 1 MiB source, 16-Revision, and 2 MiB aggregate caps no longer govern local-first behavior.
- [ ] Legacy contracts remain only where required for read, export, migration, and deletion compatibility.
- [ ] Permanent workspace and public capabilities no longer exist after the migration window.
- [ ] Compatibility and regression tests prove that supported Legacy reads and local-first workflows remain green after contraction.
