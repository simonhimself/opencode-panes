# Upgrading from v0.1/v0.2

The goal has not changed: create artifacts in OpenCode and share them through
Cloudflare. What changed is how much Panes asks you to manage.

| Area                        | Before: v0.2                                          | Now                                                            |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Local work                  | Managed Drafts and immutable local `vN` folders       | Ordinary editable files in your project                        |
| Getting work into the cloud | Finalize, then Sync all unsynced local history        | Upload the selected file or folder as one snapshot             |
| Version history             | A local ledger synchronized to the cloud              | Cloud versions created by uploads; Git remains separate        |
| Private management          | Inventory plus expiring Creator links                 | One owner dashboard with stable navigation links               |
| Organization                | Administrative cards with lifecycle metadata          | Light visual library with projects, search, and sharing status |
| Sharing                     | Creator/Publication terminology and mandatory expiry  | Publish, Copy link, Update shared version, and optional expiry |
| Source formats              | Built-in React, Markdown, Mermaid, and code renderers | HTML, SVG, and locally built browser-ready output              |
| Recovery and migration      | Per-artifact reconnect and legacy adoption            | No per-artifact recovery or compatibility workflow             |

v0.1 was simpler than v0.2, but it uploaded a single source string immediately.
The new version is not a rollback: it keeps multi-file support and explicit
private uploads while removing the managed local lifecycle.

Security was not removed. Owner authentication, private storage, isolated
previews, safe paths, secret-file exclusions, checksums, and explicit sharing
remain. Cloudflare still supplies the Worker, D1, and private R2 storage.

## Compatibility

This version intentionally replaces the v0.1/v0.2 workflows. Old Creator links,
local manifests, recovery/adoption tools, and source-string APIs are not supported.
Historical migrations remain in Git; old cloud data is not automatically exposed
by the new library. Existing remote data is not erased by merely building this
version. See [storage cleanup](storage-cleanup.md) for retiring legacy data and
the [v0.3 release notes](releases/v0.3.md) for the breaking changes.
