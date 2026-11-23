# Database backup and rollback

## Pre-migration safety backups (#955)

Every time `runMigrations()` is about to apply one or more pending migrations on
startup it creates an online SQLite backup of the database **before** the first
pending migration runs:

- Path: `<DB_PATH>.pre-v<N>.bak`, where `N` is the first pending migration
  version (for example `data/escrow.db.pre-v11.bak`).
- Created with better-sqlite3's `db.backup(path)` (SQLite online backup API),
  so the copy is consistent even when WAL mode is active.
- In-memory databases (`:memory:`) are never backed up.
- The indexer keeps the **two most recent** `.pre-v*.bak` files per database and
  removes older ones automatically.
- The backup path is logged at startup as `Created pre-migration SQLite backup`.
- If no migrations are pending, no backup file is written.

## Deploy rollback (`deploy/deploy.sh`)

`deploy.sh` records the highest `schema_migrations.version` in the host database
before deploying the backend image. On a failed health check it:

1. Compares the post-failure schema version to the pre-deploy version.
2. If migrations were applied, restores the newest `<DB_PATH>.pre-v*.bak` over the
   database file and removes any stale `-wal`/`-shm` sidecars.
3. Restarts the previous image tag.

The host database path defaults to `./data/escrow.db` (matching the Compose bind
mount) and can be overridden with `DB_PATH_HOST`. `sqlite3` is used when
available on the host; otherwise the script falls back to running `sqlite3`
inside an ephemeral `alpine` container.

## When there is no backup

If no pre-migration backup exists (for example, the failed release did not apply
migrations, or the database is new), the script logs the condition and proceeds
with the image rollback only. Routine operational backups remain the
responsibility of `deploy/backup.sh` / the existing backup cron.