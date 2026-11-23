#!/usr/bin/env bash
# Online backup of the indexer SQLite database to S3.
#
# Uses sqlite3's .backup, which gives a consistent copy while the indexer is
# running (safe under WAL). The copy is verified, gzipped and uploaded under a
# date-based key, so re-running on the same day overwrites that day's object
# instead of creating duplicates (idempotent). Any failure exits non-zero.
#
# Required: BACKUP_S3_BUCKET
# Optional: DB_PATH (default /opt/escrow/data/escrow.db)
#           BACKUP_S3_PREFIX (default escrow-backend/indexer)

set -euo pipefail

DB_PATH="${DB_PATH:-/opt/escrow/data/escrow.db}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-escrow-backend/indexer}"

log() { echo "[backup] $(date -u +%FT%TZ) $*"; }
fail() { echo "[backup] ERROR: $*" >&2; exit 1; }

for cmd in sqlite3 gzip aws; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done

[ -f "$DB_PATH" ] || fail "database not found: $DB_PATH"

WORK_DIR="$(mktemp -d)"
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