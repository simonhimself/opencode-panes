# 14: Download a selected Revision as a safe ZIP

**What to build:** Let Creator and public viewers download the Revision they are authorized to see as a portable archive. The archive contains exact Artifact files and no capability, credential, or private cloud metadata.

**Blocked by:** 11: Open synced Revisions in the Creator workspace; 13: Isolate public multi-file Publications

**Status:** ready-for-agent

- [ ] Creator download can select any synced Revision authorized by its Creator link.
- [ ] Public download always uses only the active Publication's selected Revision.
- [ ] ZIP entries preserve exact file bytes, nested structure, empty directories, and portable modes.
- [ ] Entry names are normalized and cannot perform archive traversal or collide after normalization.
- [ ] The download filename follows `<artifact-slug>-vN.zip` with unsafe characters removed.
- [ ] Archives exclude manifests fields that are cloud-only and all credentials, tokens, reconnect codes, and object identifiers.
- [ ] Binary and maximum-size Revisions are streamed without requiring a larger uncompressed in-memory copy.
