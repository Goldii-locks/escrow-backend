#!/usr/bin/env bash
# Online backup of the indexer SQLite database to S3.
#
# Uses sqlite3's .backup, which gives a consistent copy while the indexer is
# running (safe under WAL). The copy is verified, gzipped and uploaded under a
# date-based key, so re-running on the same day overwrites that day's object
# instead of creating duplicates (idempotent). Any failure exits non-zero.
#
# On success a heartbeat is published (CloudWatch metric and/or ping URL) so a
# missing heartbeat can alarm; see deploy/BACKUP.md (#937).
#
# Required: BACKUP_S3_BUCKET (must not be the YOUR_BUCKET placeholder)
# Optional: DB_PATH (default /opt/escrow/data/escrow.db)
#           BACKUP_S3_PREFIX (default escrow-backend/indexer)
#           BACKUP_HEARTBEAT_URL  ping URL requested after a successful run
#           BACKUP_CLOUDWATCH_NAMESPACE  when set, publish EscrowBackupSuccess=1
#                                        to this CloudWatch namespace
#           BACKUP_TMPDIR  scratch directory (default: system temp dir)

set -euo pipefail

DB_PATH="${DB_PATH:-/opt/escrow/data/escrow.db}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-escrow-backend/indexer}"

log() { echo "[backup] $(date -u +%FT%TZ) $*"; }
fail() { echo "[backup] ERROR: $*" >&2; exit 1; }

[ "$BACKUP_S3_BUCKET" != "YOUR_BUCKET" ] || fail "BACKUP_S3_BUCKET is still the YOUR_BUCKET placeholder; set a real bucket in /etc/cron.d/escrow-backup"

for cmd in sqlite3 gzip aws; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  command -v curl >/dev/null 2>&1 || fail "required command not found: curl (BACKUP_HEARTBEAT_URL is set)"
fi

[ -f "$DB_PATH" ] || fail "database not found: $DB_PATH"

if [ -n "${BACKUP_TMPDIR:-}" ]; then
  WORK_DIR="$(mktemp -d -p "$BACKUP_TMPDIR")"
else
  WORK_DIR="$(mktemp -d)"
fi
trap 'rm -rf "$WORK_DIR"' EXIT

STAMP="$(date +%F)"
BACKUP_FILE="$WORK_DIR/escrow-${STAMP}.db"
S3_URI="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/escrow-${STAMP}.db.gz"

log "backing up $DB_PATH"
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

RESULT="$(sqlite3 "$BACKUP_FILE" 'PRAGMA integrity_check;')"
[ "$RESULT" = "ok" ] || fail "integrity check failed on backup: $RESULT"

gzip -9 "$BACKUP_FILE"

log "uploading to $S3_URI"
aws s3 cp "${BACKUP_FILE}.gz" "$S3_URI" --only-show-errors

log "done"

# Heartbeat: only reached when every step above succeeded (set -e). A failure
# here fails the run too, since an unreported backup is indistinguishable from
# a failed one.
if [ -n "${BACKUP_CLOUDWATCH_NAMESPACE:-}" ]; then
  aws cloudwatch put-metric-data --namespace "$BACKUP_CLOUDWATCH_NAMESPACE" \
    --metric-name EscrowBackupSuccess --value 1 --unit Count
  log "published CloudWatch metric EscrowBackupSuccess"
fi
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_HEARTBEAT_URL"
  log "pinged heartbeat URL"
fi
