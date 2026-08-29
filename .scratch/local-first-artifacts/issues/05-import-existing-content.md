# 05: Import existing files and directories

**What to build:** Bring an existing file or directory into the same local Artifact workflow through a complete, recoverable copy. Imported content remains untouched unless the creator separately confirms removal after successful verification.

**Blocked by:** 03: Finalize an immutable Revision with a Local preview

**Status:** ready-for-agent

- [ ] Import accepts one file or one directory and copies exact text and binary bytes through a temporary destination.
- [ ] A complete copy is installed atomically as Draft; partial failures leave no apparently complete import.
- [ ] Destination collisions require an explicit choice and never silently merge or overwrite content.
- [ ] The simple source-and-filename convenience flow creates a one-file Draft and follows normal validation and finalization.
- [ ] Successful import returns a short-lived verification receipt bound to the source snapshot, destination Artifact, and import operation.
- [ ] A second Import action accepts that receipt only after explicit deletion confirmation, immediately re-hashes the source, and refuses deletion if the receipt expired or the source changed.
- [ ] Successful deletion consumes the receipt; cancellation and ordinary import leave the source unchanged.
- [ ] Nested files, empty directories, unusual valid filenames, and binary content have integration coverage.
