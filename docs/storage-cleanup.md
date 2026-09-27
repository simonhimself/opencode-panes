# Storage Cleanup

## Scope

Panes has two distinct cleanup operations:

- One-time retirement of the pre-v0.3 cloud data model and its unused Worker
  secret names.
- Routine cleanup of uploads that never became committed library versions.

Neither operation deletes ordinary local files. The current library, completed
versions, active shares, and current upload credential must be preserved.

## Legacy retirement

Retirement must use an explicit allowlist derived from migrations `0001` through
`0010` and the old file-storage implementation. Never infer that an unknown table
or object is disposable merely because it does not look current.

Use a new forward-only migration to drop retired D1 tables in foreign-key-safe
order. Preserve all historical migration files and D1 migration receipts. Before
applying it, verify that current code does not reference the retired tables and
that no current library table has a foreign key into them.

Remove only verified legacy R2 prefixes. In particular, **preserve every object
under `library/`**, which holds current uploaded versions. Keep the bucket private;
do not empty or replace it. Inventory counts and byte totals before and after
cleanup without exporting artifact contents or bearer tokens.

The retired Worker secret names are `PANES_CREATE_API_KEY` and
`PUBLICATION_ENCRYPTION_KEY_V1`. Preserve `PANES_UPLOAD_KEY`. Removing a Worker
secret changes the live Worker version; verify that the current code, bindings,
and traffic configuration remain intact afterward.

**Do not delete the local file named `opencode-panes-create-key`.** The owner
reused that protected file for the current upload key, and the installed plugin
references it. The old filename does not make the credential obsolete.

Retirement ends the ready-to-use rollback path to the pre-v0.3 application.
Cloudflare's own version history or database recovery retention is separate;
removing active data is not a claim that every provider-managed backup is erased.

## Verification

For the one-time cleanup, record the precise retired table names, R2 prefixes,
object counts/bytes, and removed secret names. Confirm that current library row
counts and the previously inventoried `library/` objects remain present. If new
uploads occur concurrently, additions are expected; disappearance is not.

Routine cleanup needs regression coverage proving that committed versions and
shares survive, expired upload IDs cannot write or commit, identical uploads can
restart, in-flight operations cannot resurrect abandoned bytes, and bounded
sweeps make progress after failures.

Do not publish or rotate a share merely to verify cleanup. Check the existing
owner library and read-only previews without changing their sharing state.
