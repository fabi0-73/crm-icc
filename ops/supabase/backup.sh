#!/bin/bash
# Nightly backup of the self-hosted Supabase stack.
#
# Covers everything needed to rebuild from nothing: the database (which
# includes the auth and storage schemas), the roles, the attachment files
# and the stack's own .env — without which the dumps are useless, because
# the anon/service keys are derived from JWT_SECRET.
#
# Ends by pinging a dead-man's switch, so the alert fires when this script
# does NOT run. That is the failure everyone misses.
#
# Install: /srv/supabase/backup.sh, run from /etc/cron.d/supabase-ops.
set -euo pipefail

STACK=${STACK:-/srv/supabase}
DEST=${DEST:-/var/backups/supabase}
RETENTION_DAYS=${RETENTION_DAYS:-14}
RCLONE_REMOTE=${RCLONE_REMOTE:-b2crypt:icc-backups}
PING_URL=${BACKUP_PING_URL:-}
# A dump smaller than this means something went wrong; a truncated backup
# that looks successful is worse than no backup at all.
MIN_DUMP_BYTES=${MIN_DUMP_BYTES:-20000}

STAMP=$(date +%F_%H%M)
mkdir -p "$DEST"
cd "$STACK"

echo "[$(date -Is)] backup starting"

docker compose exec -T db pg_dumpall -U supabase_admin --roles-only \
  | gzip >"$DEST/roles_$STAMP.sql.gz"

docker compose exec -T db pg_dump -U supabase_admin -Fc -d postgres \
  >"$DEST/db_$STAMP.dump"

tar czf "$DEST/storage_$STAMP.tgz" -C "$STACK/volumes" storage

install -m 600 "$STACK/.env" "$DEST/env_$STAMP"

SIZE=$(stat -c%s "$DEST/db_$STAMP.dump")
if [ "$SIZE" -lt "$MIN_DUMP_BYTES" ]; then
  echo "FATAL: database dump is only ${SIZE} bytes (expected >= ${MIN_DUMP_BYTES})" >&2
  exit 1
fi

# Confirm the dump is readable, not just non-empty.
if ! pg_restore --list "$DEST/db_$STAMP.dump" >/dev/null 2>&1; then
  if ! docker compose exec -T db pg_restore --list /dev/stdin \
        <"$DEST/db_$STAMP.dump" >/dev/null 2>&1; then
    echo "FATAL: pg_restore cannot read the dump" >&2
    exit 1
  fi
fi

find "$DEST" -type f -mtime +"$RETENTION_DAYS" -delete

if command -v rclone >/dev/null 2>&1; then
  rclone sync "$DEST" "$RCLONE_REMOTE" --log-file /var/log/rclone-backup.log
else
  echo "WARNING: rclone missing — backup exists ON THE BOX ONLY" >&2
  exit 1
fi

if [ -n "$PING_URL" ]; then
  curl -fsS -m 20 "$PING_URL" >/dev/null || echo "WARNING: ping failed" >&2
fi

echo "[$(date -Is)] backup ok: db_$STAMP.dump (${SIZE} bytes), mirrored to $RCLONE_REMOTE"
