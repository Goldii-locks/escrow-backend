# Indexer database backups

All indexed state lives in one SQLite file on the host at
`/opt/escrow/data/escrow.db` (mounted into the backend container at
`/app/data`). `deploy/backup.sh` runs on the host, takes an online, consistent
copy with `sqlite3 .backup` (safe under WAL), checks it with
`PRAGMA integrity_check`, gzips it and uploads it to
`s3://<bucket>/escrow-backend/indexer/escrow-YYYY-MM-DD.db.gz`.
Running it twice on the same day overwrites that day's object, and any failure
exits non-zero.

## Setup

1. Install `sqlite3`, `gzip` and the AWS CLI on the instance.
2. Create the bucket and apply the lifecycle rule (30-day expiry):
   `aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://deploy/backup-lifecycle-policy.json`
3. Attach `deploy/backup-iam-policy.json` to the deploy role, with `YOUR_BUCKET`
   replaced. It grants `s3:PutObject` on the backup prefix only.
4. Install the script and the cron entry (set `BACKUP_S3_BUCKET` in
   `deploy/backup.cron` first):
   `sudo install -m 755 deploy/backup.sh /opt/escrow/backup.sh`
   `sudo cp deploy/backup.cron /etc/cron.d/escrow-backup`
5. Run it once by hand to confirm it works:
   `sudo BACKUP_S3_BUCKET=<bucket> /opt/escrow/backup.sh`

## Restore

Restoring needs read access (`s3:GetObject`), which the deploy role does not
have. Use an operator role.

1. Download the backup:
   `aws s3 cp s3://<bucket>/escrow-backend/indexer/escrow-YYYY-MM-DD.db.gz .`
2. Unpack it: `gunzip escrow-YYYY-MM-DD.db.gz`
3. Stop the backend: `cd /opt/escrow && docker compose stop backend`
4. Move the old database aside, then copy the restored file to
   `/opt/escrow/data/escrow.db`. Delete any stale `escrow.db-wal` and
   `escrow.db-shm` files next to it.
5. Make the app able to read it: `sudo chown 1001 /opt/escrow/data/escrow.db`
6. Start the backend: `cd /opt/escrow && docker compose up -d backend`
7. Check `GET /api/admin/indexer-status` and confirm `lastIndexedLedger`
   matches the value from before the backup.

The restore procedure has not been run end to end against a real bucket yet.