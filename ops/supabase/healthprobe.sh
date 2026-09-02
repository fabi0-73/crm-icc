#!/bin/bash
# Runs every 5 minutes from /etc/cron.d/supabase-ops.
#
# Pings a dead-man's switch ONLY when everything is green, so this script
# needs no alerting path of its own — silence is the alert.
#
# Beyond "is it up", it watches the two things that actually kill this
# stack: the disk filling, and a replication slot falling behind and
# pinning WAL. On this box that would also take down the unrelated
# trading bots, so the threshold is deliberately conservative.
set -uo pipefail

STACK=${STACK:-/srv/supabase}
PING_URL=${HEALTH_PING_URL:-}
DISK_LIMIT=${DISK_LIMIT:-80}                 # percent
SLOT_LAG_LIMIT=${SLOT_LAG_LIMIT:-536870912}  # 512 MB, matches max_slot_wal_keep_size

fail() {
  echo "[$(date -Is)] UNHEALTHY: $1" >&2
  exit 1
}

[ -r "$STACK/.env" ] || fail "cannot read $STACK/.env"
# shellcheck disable=SC1091
set -a; . "$STACK/.env"; set +a

code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }

[ "$(code https://iccdesk.duckdns.org/login)" = "200" ] \
  || fail "app not answering on https://iccdesk.duckdns.org/login"

[ "$(code http://127.0.0.1:8000/auth/v1/health)" = "200" ] \
  || fail "auth (GoTrue) not answering"

[ "$(code -H "apikey: ${ANON_KEY}" http://127.0.0.1:8000/rest/v1/)" = "200" ] \
  || fail "rest (PostgREST) not answering"

DISK=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${DISK:-100}" -lt "$DISK_LIMIT" ] || fail "disk ${DISK}% full (limit ${DISK_LIMIT}%)"

LAG=$(cd "$STACK" && docker compose exec -T db psql -U supabase_admin -d postgres -tAc \
  "select coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))::bigint, 0)
     from pg_replication_slots" 2>/dev/null | tr -dc '0-9')
[ -n "${LAG:-}" ] || fail "cannot read pg_replication_slots (is the db container up?)"
[ "$LAG" -lt "$SLOT_LAG_LIMIT" ] \
  || fail "replication slot is ${LAG} bytes behind — WAL is being pinned"

if [ -n "$PING_URL" ]; then
  curl -fsS -m 10 "$PING_URL" >/dev/null || echo "WARNING: ping failed" >&2
fi

echo "[$(date -Is)] all green (disk ${DISK}%, slot lag ${LAG} bytes)"
