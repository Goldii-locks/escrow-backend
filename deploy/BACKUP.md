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

## Backup monitoring and alerting (#937)

A backup that fails silently is only discovered when a restore is needed, so
`deploy/backup.sh` reports success and an alarm fires when the report is missing.
Failures it can hit: full disk, expired AWS credentials, a failed integrity
check, or the `YOUR_BUCKET` placeholder never replaced (the script now exits
immediately in that case).

### Heartbeat on success

After a fully successful run (backup, integrity check and upload) the script
publishes a heartbeat. Configure either or both in `/etc/cron.d/escrow-backup`:

| Variable | Effect |
| --- | --- |
| `BACKUP_CLOUDWATCH_NAMESPACE` | `aws cloudwatch put-metric-data` with metric `EscrowBackupSuccess=1` in that namespace. The instance role needs `cloudwatch:PutMetricData`. |
| `BACKUP_HEARTBEAT_URL` | `curl` of this URL (healthchecks.io, Cronitor, etc.). |

Nothing is published on failure, so the alarm below is the alert path.

### Alarm: no heartbeat for 26 hours

The job runs every 24 h, so 26 h allows one run plus slack.

- **CloudWatch:** alarm on `EscrowBackupSuccess`, statistic `Sum`, period 1 h,
  26 evaluation periods, threshold `< 1`, **treat missing data as breaching**,
  action: an SNS topic that notifies the on-call:

  ```sh
  aws cloudwatch put-metric-alarm --alarm-name escrow-backup-missing \
    --namespace Escrow --metric-name EscrowBackupSuccess --statistic Sum \
    --period 3600 --evaluation-periods 26 --datapoints-to-alarm 26 \
    --threshold 1 --comparison-operator LessThanThreshold \
    --treat-missing-data breaching --alarm-actions <sns-topic-arn>
  ```

- **Ping URL service:** create a check with a 24 h period and a 2 h grace
  period (26 h total) and route its alerts to the on-call.

When the alarm fires, check `/var/log/escrow-backup.log`: the script logs
`[backup] ERROR: ...` with the reason.

## Restore test (`deploy/restore-test.sh`)

A backup that cannot be restored is not a backup. `restore-test.sh` runs
monthly from cron (1st of the month, 05:00 UTC). It downloads the newest
`escrow-*.db.gz` from the bucket, restores it into a scratch directory, and
requires `PRAGMA integrity_check` to return `ok` and `SELECT COUNT(*) FROM
events` to succeed. It exits non-zero on any failure and reports success the
same way as the backup: `BACKUP_CLOUDWATCH_NAMESPACE` publishes
`EscrowRestoreTestSuccess=1`, and `RESTORE_TEST_HEARTBEAT_URL` is pinged.
Alarm on it like the backup heartbeat, with a window of about 35 days.

Run it by hand any time:

```sh
BACKUP_S3_BUCKET=my-bucket /opt/escrow/restore-test.sh
```

Set `BACKUP_TMPDIR` to a volume with free space if the root volume is small;
both scripts use it for the scratch copy.