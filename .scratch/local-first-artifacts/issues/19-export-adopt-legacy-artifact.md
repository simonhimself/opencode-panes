# 19: Export and adopt a Legacy artifact locally

**What to build:** Let the creator export a readable Legacy artifact into the current project and continue it under the local-first workflow. The adopted Artifact starts with a valid local `v1`, gains a new cloud identity on Sync, and leaves the original legacy history intact.

**Blocked by:** 05: Import existing files and directories; 10: Harden Sync recovery and Creator-link lifecycle; 18: Migrate cloud-first Artifacts to read-only Legacy artifacts

**Status:** ready-for-agent

- [ ] Export starts from the authenticated Cloud inventory and transfers an authorized adoption payload to the plugin without exposing an Owner credential.
- [ ] The plugin converts Legacy source into a valid project Artifact manifest and finalized `v1` without transforming the source bytes.
- [ ] The exported Revision selects the appropriate direct-browser or Panes-renderer Preview adapter for its legacy renderer.
- [ ] Export uses normal collision, atomic-copy, and local validation rules and never writes credentials into the project.
- [ ] The adopted Artifact can be previewed, revised through Draft, and synchronized through the local-first tools.
- [ ] First Sync creates a new local-first cloud Artifact identity rather than mutating the Legacy artifact.
- [ ] The original Legacy artifact, Revisions, and history remain readable until expiry or explicit dashboard deletion.
- [ ] Inventory and viewer actions clearly distinguish the adopted Artifact from its Legacy source.
