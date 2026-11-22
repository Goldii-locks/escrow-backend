#!/usr/bin/env bash
# Restore test for the indexer database backups (#937).
#
# Downloads the newest backup from S3, restores it into a scratch directory and
# checks it: PRAGMA integrity_check must return "ok" and SELECT COUNT(*) FROM
# events must succeed. The result is reported the same way as backup.sh: a
# non-zero exit on failure and, on success, the same heartbeat mechanisms.
#
# Required: BACKUP_S3_BUCKET (must not be the YOUR_BUCKET placeholder)
# Optional: BACKUP_S3_PREFIX (default escrow-backend/indexer)
#           RESTORE_TEST_HEARTBEAT_URL  ping URL requested after a successful run
#           BACKUP_CLOUDWATCH_NAMESPACE  when set, publish EscrowRestoreTestSuccess=1
#           BACKUP_TMPDIR  scratch directory (default: system temp dir)

set -euo pipefail

BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-escrow-backend/indexer}"

log() { echo "[restore-test] $(date -u +%FT%TZ) $*"; }
fail() { echo "[restore-test] ERROR: $*" >&2; exit 1; }

[ "$BACKUP_S3_BUCKET" != "YOUR_BUCKET" ] || fail "BACKUP_S3_BUCKET is still the YOUR_BUCKET placeholder"

for cmd in sqlite3 gunzip aws; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done
if [ -n "${RESTORE_TEST_HEARTBEAT_URL:-}" ]; then
  command -v curl >/dev/null 2>&1 || fail "required command not found: curl (RESTORE_TEST_HEARTBEAT_URL is set)"
fi

if [ -n "${BACKUP_TMPDIR:-}" ]; then
  WORK_DIR="$(mktemp -d -p "$BACKUP_TMPDIR")"
else
  WORK_DIR="$(mktemp -d)"
fi
trap 'rm -rf "$WORK_DIR"' EXIT

# Keys embed the date (escrow-YYYY-MM-DD.db.gz), so the lexically last is newest.
LATEST_KEY="$(aws s3 ls "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/" \
  | awk '{print $4}' | grep -E '^escrow-.*\.db\.gz$' | sort | tail -n 1 || true)"
[ -n "$LATEST_KEY" ] || fail "no backups found under s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/"

log "downloading $LATEST_KEY"
aws s3 cp "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/${LATEST_KEY}" "$WORK_DIR/$LATEST_KEY" --only-show-errors
gunzip "$WORK_DIR/$LATEST_KEY"
RESTORED="$WORK_DIR/${LATEST_KEY%.gz}"

RESULT="$(sqlite3 "$RESTORED" 'PRAGMA integrity_check;')"
[ "$RESULT" = "ok" ] || fail "integrity check failed on restored $LATEST_KEY: $RESULT"

EVENT_COUNT="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM events;')" \
  || fail "could not count events in restored $LATEST_KEY"
log "restore OK: $LATEST_KEY integrity=ok events=$EVENT_COUNT"

if [ -n "${BACKUP_CLOUDWATCH_NAMESPACE:-}" ]; then
  aws cloudwatch put-metric-data --namespace "$BACKUP_CLOUDWATCH_NAMESPACE" \
    --metric-name EscrowRestoreTestSuccess --value 1 --unit Count
  log "published CloudWatch metric EscrowRestoreTestSuccess"
fi
if [ -n "${RESTORE_TEST_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$RESTORE_TEST_HEARTBEAT_URL"
  log "pinged restore-test heartbeat URL"
fi
