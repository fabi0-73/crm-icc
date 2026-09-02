# Self-hosted Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the ICC Desk backend (Postgres, Auth, REST, Realtime, Storage) on the project's own VPS instead of Supabase Cloud's free tier, with backups, alerting and a runbook that one person can operate.

**Architecture:** A pruned six-service Supabase Docker Compose stack on `72.62.42.52`, every port bound to `127.0.0.1`, reached through the existing nginx TLS certificate at `https://iccdesk.duckdns.org/sb/`. Data moves with the Supabase CLI's three-dump procedure (bcrypt password hashes survive, so nobody resets a password) and files move over the S3 protocol. The cloud project stays untouched for 14 days as the rollback.

**Tech Stack:** Docker Engine + Compose plugin, `supabase/postgres` 17, `supabase/gotrue`, `postgrest/postgrest`, `supabase/realtime`, `supabase/storage-api`, `kong`, nginx, ufw, rclone → Backblaze B2, healthchecks.io.

**Spec:** `docs/superpowers/specs/2026-09-02-self-hosted-supabase-design.md`

## Global Constraints

- **The repository is PUBLIC.** No secret, key, password or token may be committed. Repo files are templates with placeholders; real values live only in `/srv/supabase/.env` on the server, `chmod 600`, root-owned.
- **Nothing new may listen on a public interface.** Every published container port binds `127.0.0.1`. The only public entrance stays nginx on 443.
- **Postgres major version is 17**, matching the cloud project, so dumps restore without a version jump.
- **Analytics (Logflare) and vector are never enabled** — they are the documented cause of OOM at 2 GB and of runaway-WAL incidents.
- **The API path prefix is `/sb/`, never `/api/`** — Next.js owns `/api`.
- **The self-hosted GoTrue image must be at least as new as cloud's**, and the stack must boot once (so GoTrue/Storage run their own schema migrations) *before* any auth data is restored.
- **Existing users' passwords must keep working.** They cannot receive email; a flow that requires a password reset is a failed migration.
- **No step may interrupt the trading bots or their Postgres instances** (`127.0.0.1:5433`, `:5432`).
- Server paths: stack `/srv/supabase`, app `/srv/apps/crm-icc`, backups `/var/backups/supabase`.
- Deploys continue to use `scripts/deploy.sh` (git archive of HEAD → build on server → restart `crm-icc.service`).

---

### Task 1: Vendor the pruned compose stack and env template

Upstream's compose ships fourteen services. We vendor a pruned copy so the running stack is reviewable in git and an upgrade is a readable diff.

**Files:**
- Create: `ops/supabase/docker-compose.yml`
- Create: `ops/supabase/.env.example`
- Create: `ops/supabase/README.md`
- Modify: `.gitattributes` (keep `ops/` out of the app deploy archive)

**Interfaces:**
- Consumes: nothing.
- Produces: `/srv/supabase/docker-compose.yml` contents; the exact env var names Task 5 fills in: `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `SITE_URL`, `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `REALTIME_SLOT_NAME`.

- [ ] **Step 1: Fetch upstream compose at a pinned release**

```bash
cd /tmp && rm -rf supabase-src && git clone --depth 1 --branch self-hosted/v0.7.0 \
  https://github.com/supabase/supabase.git supabase-src
ls supabase-src/docker
```
Expected: `docker-compose.yml`, `.env.example`, `volumes/`, `dev/`.
If the tag does not exist, list tags with `git ls-remote --tags https://github.com/supabase/supabase.git 'self-hosted/*'` and pin the newest `self-hosted/v0.7.x`. **Do not pin ≥ v0.8.0** — Envoy replaces Kong there and the nginx block in Task 6 would need re-verification.

- [ ] **Step 2: Record which services exist and what depends on what**

```bash
cd /tmp/supabase-src/docker
grep -nE '^  [a-z-]+:|depends_on|condition:|image:' docker-compose.yml | head -80
```
Write the service list and every `depends_on` into the commit message. A pruned service that another service still depends on will block startup — this is the one thing that makes Task 5 fail.

- [ ] **Step 3: Write the pruned compose file**

Copy upstream's `docker-compose.yml` to `ops/supabase/docker-compose.yml`, then:
1. Delete the `studio`, `meta`, `functions`, `imgproxy`, `analytics`, `vector`, `supavisor` (pooler) service blocks.
2. Delete every `depends_on` entry referring to a deleted service.
3. Pin every remaining `image:` to an exact tag (no `latest`).
4. Change every `ports:` entry to bind loopback only — `"127.0.0.1:8000:8000"` for kong; **remove** the `db` port mapping entirely (migrations run via `docker compose exec`).
5. Add to each service: `restart: unless-stopped`, and `mem_limit` — `db: 1500m`, `realtime: 512m`, `storage: 384m`, `auth: 256m`, `rest: 256m`, `kong: 512m`.
6. Ensure the db command includes `-c wal_level=logical -c max_slot_wal_keep_size=512MB` (bounded so a lagging slot is dropped instead of filling the disk).

- [ ] **Step 4: Write `ops/supabase/.env.example` with placeholders only**

Every value is a placeholder; the file is committed to a public repo.

```dotenv
# Generated on the server by ops/supabase/generate-secrets.sh — never commit real values.
POSTGRES_PASSWORD=REPLACE_ME
JWT_SECRET=REPLACE_ME_40_PLUS_CHARS
ANON_KEY=REPLACE_ME_JWT_SIGNED_WITH_JWT_SECRET
SERVICE_ROLE_KEY=REPLACE_ME_JWT_SIGNED_WITH_JWT_SECRET
SECRET_KEY_BASE=REPLACE_ME_64_CHARS
VAULT_ENC_KEY=REPLACE_ME_32_CHARS
DASHBOARD_USERNAME=unused-studio-is-not-deployed
DASHBOARD_PASSWORD=unused-studio-is-not-deployed

SITE_URL=https://iccdesk.duckdns.org
API_EXTERNAL_URL=https://iccdesk.duckdns.org/sb
SUPABASE_PUBLIC_URL=https://iccdesk.duckdns.org/sb

# Admin-provisioned accounts only: no public signup, no email delivery.
DISABLE_SIGNUP=true
ENABLE_EMAIL_SIGNUP=true
ENABLE_EMAIL_AUTOCONFIRM=true
ENABLE_ANONYMOUS_USERS=false
JWT_EXPIRY=3600

REALTIME_SLOT_NAME=supabase_realtime_icc
STORAGE_BACKEND=file
FILE_SIZE_LIMIT=52428800
```

- [ ] **Step 5: Keep `ops/` out of the app deploy bundle**

Append to `.gitattributes` (patterns must stay root-anchored — an unanchored `ops` once silently dropped `src/components/mobile` from a deploy):

```gitattributes
/ops export-ignore
```

- [ ] **Step 6: Verify the compose file is valid and contains only the six services**

```bash
cd ops/supabase && cp .env.example .env.validate && \
  docker compose --env-file .env.validate config --services | sort
rm .env.validate
```
Expected exactly: `auth`, `db`, `kong`, `realtime`, `rest`, `storage`.
If Docker is not on the workstation, run this in Task 4 on the server instead and note it.

- [ ] **Step 7: Verify no secret slipped in**

```bash
git add -A ops/ .gitattributes
git diff --cached | grep -nEi 'eyJ[A-Za-z0-9_-]{10,}|BEGIN .*PRIVATE KEY|password *= *[^R]' || echo "clean"
```
Expected: `clean`.

- [ ] **Step 8: Commit**

```bash
git commit -m "ops: vendor a pruned six-service Supabase compose stack

Derived from upstream self-hosted/v0.7.0. Studio, meta, functions,
imgproxy, analytics, vector and the pooler are removed; analytics is the
documented cause of OOM at 2 GB and of runaway WAL. Ports bind to
loopback only and the database port is not published at all."
```

---

### Task 2: Backup, health-probe and restore-drill scripts

**Files:**
- Create: `ops/supabase/backup.sh`
- Create: `ops/supabase/healthprobe.sh`
- Create: `ops/supabase/restore-drill.md`

**Interfaces:**
- Consumes: `/srv/supabase/.env` (Task 5), `/srv/supabase/docker-compose.yml` (Task 1).
- Produces: `/var/backups/supabase/{db_*.dump,roles_*.sql.gz,storage_*.tgz}`; two healthchecks.io ping URLs consumed by Task 8's cron.

- [ ] **Step 1: Write `ops/supabase/backup.sh`**

```bash
#!/bin/bash
# Nightly backup: database (custom format), roles, storage files, env.
# Retention 14 days on-box, mirrored encrypted off-box, then pings a
# dead-man's switch so a backup that never runs raises an alert.
set -euo pipefail

STACK=/srv/supabase
DEST=/var/backups/supabase
STAMP=$(date +%F_%H%M)
PING_URL="${BACKUP_PING_URL:-}"

mkdir -p "$DEST"
cd "$STACK"

docker compose exec -T db pg_dumpall -U supabase_admin --roles-only \
  | gzip > "$DEST/roles_$STAMP.sql.gz"
docker compose exec -T db pg_dump -U supabase_admin -Fc -d postgres \
  > "$DEST/db_$STAMP.dump"
tar czf "$DEST/storage_$STAMP.tgz" -C "$STACK/volumes" storage
install -m 600 "$STACK/.env" "$DEST/env_$STAMP"

# A truncated dump is worse than none: fail loudly if it is implausibly small.
MIN_BYTES=20000
SIZE=$(stat -c%s "$DEST/db_$STAMP.dump")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  echo "FATAL: db dump is only ${SIZE} bytes" >&2
  exit 1
fi

find "$DEST" -type f -mtime +14 -delete
rclone sync "$DEST" b2crypt:icc-backups --log-file /var/log/rclone-backup.log

[ -n "$PING_URL" ] && curl -fsS -m 20 "$PING_URL" >/dev/null
echo "backup ok: db_$STAMP.dump ($SIZE bytes)"
```

- [ ] **Step 2: Write `ops/supabase/healthprobe.sh`**

```bash
#!/bin/bash
# Runs every 5 minutes. Pings the dead-man's switch ONLY when everything
# is green, so the alert fires on failure without needing an alert path
# of its own. Also guards the failure mode that actually happens here:
# a lagging replication slot pinning WAL until the disk fills.
set -uo pipefail
STACK=/srv/supabase
PING_URL="${HEALTH_PING_URL:-}"
set -a; . "$STACK/.env"; set +a

code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }

[ "$(code https://iccdesk.duckdns.org/login)" = "200" ] || { echo "app down"; exit 1; }
[ "$(code http://127.0.0.1:8000/auth/v1/health)" = "200" ] || { echo "auth down"; exit 1; }
[ "$(code -H "apikey: $ANON_KEY" http://127.0.0.1:8000/rest/v1/)" = "200" ] || { echo "rest down"; exit 1; }

DISK=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$DISK" -lt 80 ] || { echo "disk ${DISK}% full"; exit 1; }

LAG=$(cd "$STACK" && docker compose exec -T db psql -U supabase_admin -d postgres -tAc \
  "select coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))::bigint, 0) from pg_replication_slots")
[ "${LAG:-0}" -lt 536870912 ] || { echo "replication slot lag ${LAG} bytes"; exit 1; }

[ -n "$PING_URL" ] && curl -fsS -m 10 "$PING_URL" >/dev/null
echo "all green (disk ${DISK}%, slot lag ${LAG})"
```

- [ ] **Step 3: Write `ops/supabase/restore-drill.md`**

Contents: restore the newest off-box dump into a throwaway stack (`docker compose -p sbdrill`), on a different port, then assert `select count(*) from auth.users` matches production and one attachment downloads. The document must end with a line to fill in: `Last drill: <date> — restored in <minutes>` — that measured number is the RTO.

- [ ] **Step 4: Shellcheck both scripts**

```bash
docker run --rm -v "$PWD/ops/supabase:/mnt" koalaman/shellcheck:stable /mnt/backup.sh /mnt/healthprobe.sh
```
Expected: no errors (warnings about `. "$STACK/.env"` sourcing are acceptable).
If Docker is unavailable locally, run `bash -n ops/supabase/backup.sh && bash -n ops/supabase/healthprobe.sh` and note that shellcheck ran on the server in Task 8.

- [ ] **Step 5: Commit**

```bash
git add ops/supabase/backup.sh ops/supabase/healthprobe.sh ops/supabase/restore-drill.md
chmod +x ops/supabase/backup.sh ops/supabase/healthprobe.sh
git commit -m "ops: nightly backup, health probe and restore drill

The probe pings a dead-man's switch only when green, so a silent failure
alerts. It also watches replication-slot lag and disk, which is the
documented way a self-hosted stack dies (WAL pinned by a stalled slot)."
```

---

### Task 3: Operator runbook

**Files:**
- Create: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: paths and service names from Tasks 1–2.
- Produces: the document the operator reads at 3am; Task 8 fills in the measured restore time.

- [ ] **Step 1: Write `docs/RUNBOOK.md`**

Sections, each with exact commands:
1. **Inventory** — VPS IP, what listens where, which systemd units, where each `.env` lives, who holds the B2 and healthchecks credentials.
2. **Start / stop / status** — `systemctl {start,stop,status} supabase`, `systemctl status crm-icc`.
3. **Where the data is** — `/srv/supabase/volumes/db/data`, `/srv/supabase/volumes/storage`, `/var/backups/supabase`.
4. **Restore** — verbatim from `ops/supabase/restore-drill.md`, with the measured duration.
5. **Rotate the JWT secret** — regenerate, re-derive both keys, update the app env, recreate the stack, and the consequence: **every session is invalidated**.
6. **Add a user** — through the app's Admin → Users screen; if the app is down, `docker compose exec` + the GoTrue admin API, never a raw `INSERT` into `auth.users`.
7. **Logs** — `docker compose logs -f <db|auth|rest|realtime|storage|kong>`, `journalctl -u crm-icc -f`, `/var/log/nginx/error.log`.
8. **Deploy the app** — `ICC_SSH_KEY=... bash scripts/deploy.sh`.
9. **Roll back to Supabase Cloud** — the three env vars to revert and redeploy; valid only within the 14-day window.
10. **Escalation** — VPS provider console, DuckDNS token location.

- [ ] **Step 2: Verify every command in the runbook is real**

```bash
grep -oE '`[^`]+`' docs/RUNBOOK.md | tr -d '`' | grep -E '^(systemctl|docker|journalctl|bash|psql)' | sort -u
```
Read the list and confirm each refers to a unit, file or service this plan actually creates. A runbook command that does not exist is worse than a missing one.

- [ ] **Step 3: Commit**

```bash
git add docs/RUNBOOK.md
git commit -m "docs: operator runbook for the self-hosted stack"
```

---

### Task 4: Server preparation — Docker, directories, loopback hardening

Everything from here runs on the VPS. Run each block, paste the output back, and stop on the first unexpected result.

**Files:**
- Server: `/etc/docker/daemon.json`, `/srv/supabase/`, `/etc/systemd/system/supabase.service`

**Interfaces:**
- Consumes: `ops/supabase/*` from Tasks 1–2.
- Produces: a host that can run the stack; `systemctl start supabase` works.

- [ ] **Step 1: Snapshot the box before changing anything**

```bash
ssh root@72.62.42.52 'free -h; df -h /; ss -tlnp | grep LISTEN; systemctl is-active crm-icc nginx'
```
Record the output in the task's commit message. This is the "before" you compare against if anything regresses.

- [ ] **Step 2: Install Docker Engine + compose plugin from the official repo**

```bash
ssh root@72.62.42.52 'set -e
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version && docker compose version'
```
Expected: versions print. **Verify the trading bots are unaffected:** `systemctl is-active postgresql@14-main postgresql@16-main` (or the units in use) still `active`.

- [ ] **Step 3: Cap container logs so they cannot fill the disk**

```bash
ssh root@72.62.42.52 'cat > /etc/docker/daemon.json <<JSON
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker && docker info --format "{{.LoggingDriver}}"'
```
Expected: `json-file`.

- [ ] **Step 4: Add the DOCKER-USER backstop so Docker cannot publish past ufw**

Docker writes its own iptables rules and bypasses ufw. Loopback binds (Task 1) are the primary defence; this is the backstop.

```bash
ssh root@72.62.42.52 'set -e
IFACE=$(ip route get 1.1.1.1 | awk "{print \$5; exit}")
echo "public interface: $IFACE"
grep -q DOCKER-USER /etc/ufw/after.rules || cat >> /etc/ufw/after.rules <<RULES

*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i '"'"'"$IFACE"'"'"' -j DROP
-A DOCKER-USER -j RETURN
COMMIT
RULES
ufw reload || true
iptables -S DOCKER-USER'
```
Expected: the DROP rule for the public interface appears.

- [ ] **Step 5: Create the stack directory and copy the vendored files**

```bash
scp -r ops/supabase root@72.62.42.52:/srv/
ssh root@72.62.42.52 'mkdir -p /srv/supabase/volumes/{db/data,storage} && ls -la /srv/supabase'
```

- [ ] **Step 6: Install the systemd unit**

```bash
ssh root@72.62.42.52 'cat > /etc/systemd/system/supabase.service <<UNIT
[Unit]
Description=Supabase (self-hosted) for ICC Desk
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/srv/supabase
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable supabase && echo enabled'
```

- [ ] **Step 7: Commit the recorded "before" snapshot**

```bash
git commit --allow-empty -m "ops: VPS prepared for the Supabase stack

Docker Engine installed from the official repo, container logs capped at
10m x3, DOCKER-USER backstop added so published ports cannot bypass ufw,
systemd unit installed. Pre-change snapshot: <paste from Step 1>."
```

---

### Task 5: Generate secrets and boot the stack empty

**Files:**
- Server: `/srv/supabase/.env` (never committed)
- Create: `ops/supabase/generate-secrets.sh`

**Interfaces:**
- Consumes: `ops/supabase/.env.example`.
- Produces: a running stack; `ANON_KEY` and `SERVICE_ROLE_KEY` used by Task 9's app env.

- [ ] **Step 1: Write `ops/supabase/generate-secrets.sh`**

`ANON_KEY` and `SERVICE_ROLE_KEY` are **not random strings** — they are JWTs signed with `JWT_SECRET`, carrying `{"role":"anon"|"service_role","iss":"supabase"}`. A random value here produces a stack that starts and then rejects every request.

```bash
#!/bin/bash
# Writes /srv/supabase/.env from .env.example with real values.
# Run once, on the server, as root. Prints nothing secret to stdout.
set -euo pipefail
cd /srv/supabase
[ -f .env ] && { echo "refusing to overwrite existing .env"; exit 1; }

JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-32)
SECRET_KEY_BASE=$(openssl rand -hex 32)
VAULT_ENC_KEY=$(openssl rand -hex 16)

# Sign the two API keys with JWT_SECRET (HS256), 10-year expiry.
mkjwt() {
  local role="$1" now exp header payload
  now=$(date +%s); exp=$((now + 315360000))
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  payload=$(printf '{"iss":"supabase","role":"%s","iat":%s,"exp":%s}' "$role" "$now" "$exp" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  local sig
  sig=$(printf '%s.%s' "$header" "$payload" \
    | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

ANON_KEY=$(mkjwt anon)
SERVICE_ROLE_KEY=$(mkjwt service_role)

sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
    -e "s|^ANON_KEY=.*|ANON_KEY=$ANON_KEY|" \
    -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" \
    -e "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$SECRET_KEY_BASE|" \
    -e "s|^VAULT_ENC_KEY=.*|VAULT_ENC_KEY=$VAULT_ENC_KEY|" \
    .env.example > .env
chmod 600 .env; chown root:root .env
echo "wrote /srv/supabase/.env"
```

- [ ] **Step 2: Generate and verify the keys actually verify against the secret**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && bash generate-secrets.sh && \
  set -a; . ./.env; set +a; \
  python3 - <<PY
import base64,hmac,hashlib,json,os
def check(tok, secret):
    h,p,s = tok.split(".")
    signing = f"{h}.{p}".encode()
    expect = base64.urlsafe_b64encode(hmac.new(secret.encode(), signing, hashlib.sha256).digest()).rstrip(b"=").decode()
    payload = json.loads(base64.urlsafe_b64decode(p + "=="*((4-len(p)%4)%4)))
    return s == expect, payload["role"]
for name in ("ANON_KEY","SERVICE_ROLE_KEY"):
    ok, role = check(os.environ[name], os.environ["JWT_SECRET"])
    print(name, "signature", "OK" if ok else "BAD", "role", role)
PY'
```
Expected: both `signature OK`, roles `anon` and `service_role`. **Do not continue if either is BAD** — every request would 401.

- [ ] **Step 3: Boot the stack**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose up -d && sleep 45 && docker compose ps'
```
Expected: six services `running`/`healthy`, none restarting.

- [ ] **Step 4: Confirm GoTrue and Storage ran their own migrations**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose logs auth storage --tail 60 | grep -iE "migrat|error" | tail -20'
```
Expected: migrations applied, no repeating errors. A container in a restart loop here means a failed migration — read the full log before touching anything else.

- [ ] **Step 5: Verify the API answers locally, with the generated keys**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && set -a; . ./.env; set +a
curl -s http://127.0.0.1:8000/auth/v1/health; echo
curl -s -o /dev/null -w "rest:%{http_code}\n" -H "apikey: $ANON_KEY" http://127.0.0.1:8000/rest/v1/'
```
Expected: GoTrue version JSON, `rest:200`.

- [ ] **Step 6: Verify Realtime's prerequisites**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose exec -T db psql -U supabase_admin -d postgres -c "show wal_level" -c "select slot_name from pg_replication_slots" -c "select pubname from pg_publication"'
```
Expected: `wal_level = logical`, and a `supabase_realtime` publication exists (empty at this point — Task 7 populates it).

- [ ] **Step 7: Verify nothing new is publicly reachable**

```bash
ssh root@72.62.42.52 'ss -tlnp | grep -E ":8000|:5432|:5433" '
```
Expected: `8000` bound to `127.0.0.1` only; the two pre-existing Postgres ports unchanged for now (Task 10 fixes `0.0.0.0:5432`). From your workstation: `curl -m 5 http://72.62.42.52:8000/` must fail to connect.

---

### Task 6: Expose the API through nginx at `/sb/`

**Files:**
- Server: the existing `iccdesk.duckdns.org` nginx site file
- Create: `ops/nginx/iccdesk-sb.conf.example` (the block, for version control)

**Interfaces:**
- Consumes: kong on `127.0.0.1:8000`.
- Produces: `https://iccdesk.duckdns.org/sb/...` — the value Task 9 puts in `NEXT_PUBLIC_SUPABASE_URL`.

- [ ] **Step 1: Add the WebSocket upgrade map (http context, once)**

```bash
ssh root@72.62.42.52 'grep -rn "connection_upgrade" /etc/nginx/ || cat > /etc/nginx/conf.d/ws-upgrade.conf <<CONF
map \$http_upgrade \$connection_upgrade { default upgrade; "" close; }
CONF
nginx -t'
```

- [ ] **Step 2: Add the `/sb/` location to the existing 443 server block**

Insert before the final `}` of the `server { listen 443 ...; server_name iccdesk.duckdns.org; ... }` block:

```nginx
    # Self-hosted Supabase API. The trailing slash on proxy_pass strips
    # /sb so Kong sees /auth/v1/..., /rest/v1/..., /realtime/v1/... .
    location /sb/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # realtime websockets
        client_max_body_size 50m;   # attachments (bucket limit is 25m)
    }
```

- [ ] **Step 3: Reload and verify through TLS**

```bash
ssh root@72.62.42.52 'nginx -t && systemctl reload nginx'
curl -s https://iccdesk.duckdns.org/sb/auth/v1/health; echo
curl -s -o /dev/null -w "app:%{http_code}\n" https://iccdesk.duckdns.org/login
```
Expected: GoTrue version JSON, and `app:200` — the app must still work.

- [ ] **Step 4: Verify the Realtime WebSocket upgrades through nginx**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://iccdesk.duckdns.org/sb/realtime/v1/websocket?apikey=ANON_KEY&vsn=1.0.0"
```
Expected: `101` (switching protocols). A `200`/`400` means the upgrade headers are not reaching Kong — fix before Task 7.

- [ ] **Step 5: Commit the nginx block**

```bash
git add ops/nginx/iccdesk-sb.conf.example
git commit -m "ops: nginx /sb/ route to the self-hosted API

Path prefix rather than a subdomain: reuses the existing certificate and
certbot timer. /api is unavailable because Next.js owns that namespace."
```

---

### Task 7: Rehearsal migration — cloud data into the self-hosted stack

No cutover in this task. The cloud project stays live and authoritative; this proves the migration works and produces the parity numbers.

**Files:**
- Create: `ops/supabase/migrate-from-cloud.sh`
- Create: `ops/supabase/parity.sql`

**Interfaces:**
- Consumes: the running stack (Task 5), the cloud project's direct database URL.
- Produces: a populated self-hosted database and a parity report.

- [ ] **Step 1: Obtain the cloud database password**

The app authenticates with the anon/service keys, not a database password, so this value may never have been recorded. If it is unknown, reset it in the Supabase dashboard → Project Settings → Database → Reset database password. **Resetting it does not affect the running app**, because nothing connects directly. Keep it only in the shell for the duration of this task.

- [ ] **Step 2: Install the Supabase CLI on the server**

```bash
ssh root@72.62.42.52 'cd /tmp && \
  curl -fsSLO https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.deb && \
  dpkg -i supabase_linux_amd64.deb && supabase --version'
```
Dumping from the server keeps the data on the box and avoids a Windows `pg_dump` version mismatch.

- [ ] **Step 3: Write `ops/supabase/migrate-from-cloud.sh`**

```bash
#!/bin/bash
# Rehearsal/real migration of a Supabase Cloud project into this stack.
# Usage: CLOUD_DB_URL='postgresql://postgres:PW@db.REF.supabase.co:5432/postgres' ./migrate-from-cloud.sh
# Idempotent enough to re-run on a freshly recreated stack; NOT idempotent
# against a stack that already holds data.
set -euo pipefail
: "${CLOUD_DB_URL:?set CLOUD_DB_URL}"
STACK=/srv/supabase
OUT=/root/migration-$(date +%F_%H%M)
mkdir -p "$OUT"; cd "$OUT"

# storage.objects is excluded: the Storage API recreates those rows when
# the files are copied over S3, and restoring them would collide.
supabase db dump --db-url "$CLOUD_DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$CLOUD_DB_URL" -f schema.sql
supabase db dump --db-url "$CLOUD_DB_URL" -f data.sql --use-copy --data-only \
  -x storage.objects

wc -l roles.sql schema.sql data.sql

cd "$STACK"
set -a; . ./.env; set +a
LOCAL_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/postgres"

# Restore inside the db container so no port needs publishing.
for f in roles.sql schema.sql; do
  docker compose exec -T db psql --single-transaction -v ON_ERROR_STOP=1 \
    -U postgres -d postgres < "$OUT/$f"
done
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SET session_replication_role = replica" -f - < "$OUT/data.sql"

echo "restored from $OUT"
```

- [ ] **Step 4: Run it and read every error**

```bash
ssh root@72.62.42.52 "cd /srv/supabase && CLOUD_DB_URL='<url>' bash migrate-from-cloud.sh 2>&1 | tail -40"
```
Expected: no `ERROR:`. Two known causes if it fails: a PG17-only `SET transaction_timeout` in the dump (harmless — remove the line), and auth columns the self-hosted GoTrue does not have (the image is older than cloud's; pin a newer `supabase/gotrue`, recreate, boot once, retry).

- [ ] **Step 5: Repair the Realtime publication, which the dump comments out**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres \
  -c "alter publication supabase_realtime add table public.messages" \
  -c "alter publication supabase_realtime add table public.call_signals" \
  -c "select schemaname, tablename from pg_publication_tables where pubname = '"'"'supabase_realtime'"'"'"'
```
Expected: both tables listed. Ignore "already member of publication" — that means the dump did carry it.

- [ ] **Step 6: Copy the storage files over S3**

Generate S3 credentials in the cloud dashboard → Storage → S3 Configuration. Then, with both remotes in `/root/.config/rclone/rclone.conf`:

```bash
ssh root@72.62.42.52 'rclone copy platform:attachments selfhosted:attachments --progress && \
  rclone size platform:attachments && rclone size selfhosted:attachments'
```
Expected: identical object counts and byte totals. Copying files into `volumes/storage/` by hand does **not** work — the Storage API owns that layout.

- [ ] **Step 7: Write and run `ops/supabase/parity.sql`**

```sql
select 'auth.users'  as what, count(*) from auth.users
union all select 'auth.identities', count(*) from auth.identities
union all select 'profiles',  count(*) from public.profiles
union all select 'rooms',     count(*) from public.rooms
union all select 'room_members', count(*) from public.room_members
union all select 'messages',  count(*) from public.messages
union all select 'agents',    count(*) from public.agents
union all select 'assignments', count(*) from public.assignments
union all select 'audit_logs', count(*) from public.audit_logs
union all select 'storage.objects', count(*) from storage.objects where bucket_id = 'attachments'
order by 1;
```

Run against both and diff:

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres -f - < parity.sql > /tmp/local.txt; cat /tmp/local.txt'
psql "<CLOUD_DB_URL>" -f ops/supabase/parity.sql
```
Expected: identical counts. Any difference stops the cutover.

- [ ] **Step 8: Verify the grants the app depends on survived**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres \
  -c "select has_schema_privilege('"'"'authenticated'"'"','"'"'private'"'"','"'"'usage'"'"') as private_usage" \
  -c "select proname, pg_get_userbyid(proowner) as owner from pg_proc where pronamespace = '"'"'private'"'"'::regnamespace order by 1"'
```
Expected: `private_usage = t`, and the `private.*` functions exist. Without this every RLS policy fails closed and the app shows empty rooms.

- [ ] **Step 9: Prove a real password still works against the self-hosted GoTrue**

This is the single most important check in the plan.

```bash
ssh root@72.62.42.52 'cd /srv/supabase && set -a; . ./.env; set +a
curl -s -X POST "http://127.0.0.1:8000/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"fabio@iccdesk.duckdns.org\",\"password\":\"<the known admin password>\"}" \
  | head -c 200'
```
Expected: a JSON body containing `access_token`. If it returns `invalid_grant`, the auth data did not migrate correctly — do not cut over.

- [ ] **Step 10: Commit the migration scripts**

```bash
git add ops/supabase/migrate-from-cloud.sh ops/supabase/parity.sql
git commit -m "ops: cloud-to-self-hosted migration script and parity query

Excludes storage.objects (the Storage API recreates those rows when files
are copied over S3) and re-adds the realtime publication, which the
Supabase CLI deliberately comments out of the dump."
```

---

### Task 8: Backups, monitoring and a measured restore drill

Do this **before** the cutover: after the cutover the VPS holds the only copy of the data.

**Files:**
- Server: `/etc/cron.d/supabase-ops`, `/root/.config/rclone/rclone.conf`
- Modify: `ops/supabase/restore-drill.md` (fill in the measured time)

**Interfaces:**
- Consumes: `backup.sh`, `healthprobe.sh` (Task 2).
- Produces: an off-box encrypted backup and two alerting paths.

- [ ] **Step 1: Configure rclone with an encrypted Backblaze B2 remote**

```bash
ssh root@72.62.42.52 'apt-get install -y rclone && rclone config'
```
Create remote `b2` (Backblaze B2, application key), then remote `b2crypt` (type `crypt`, `remote = b2:icc-backups`, both filename and directory obfuscation on, passwords generated). **Record the crypt passwords in your password manager — without them the backups are unreadable.** First 10 GB on B2 is free.

- [ ] **Step 2: Create the two healthchecks.io checks**

Sign up (free tier), create `icc-supabase-backup` (period 1 day, grace 6 hours) and `icc-supabase-health` (period 5 minutes, grace 15 minutes). Add email and/or Telegram as the notification channel. Keep both ping URLs for the next step.

- [ ] **Step 3: Install the cron entries**

```bash
ssh root@72.62.42.52 'cat > /etc/cron.d/supabase-ops <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
BACKUP_PING_URL=https://hc-ping.com/REPLACE-BACKUP-UUID
HEALTH_PING_URL=https://hc-ping.com/REPLACE-HEALTH-UUID
15 3 * * * root /srv/supabase/backup.sh >> /var/log/supabase-backup.log 2>&1
*/5 * * * * root /srv/supabase/healthprobe.sh >> /var/log/supabase-health.log 2>&1
CRON
chmod 600 /etc/cron.d/supabase-ops && systemctl restart cron'
```

- [ ] **Step 4: Run both by hand and confirm the checks turn green**

```bash
ssh root@72.62.42.52 'set -a; . /etc/cron.d/supabase-ops 2>/dev/null || true; set +a
BACKUP_PING_URL=$(grep BACKUP_PING_URL /etc/cron.d/supabase-ops | cut -d= -f2-) /srv/supabase/backup.sh
HEALTH_PING_URL=$(grep HEALTH_PING_URL /etc/cron.d/supabase-ops | cut -d= -f2-) /srv/supabase/healthprobe.sh
ls -lh /var/backups/supabase | tail -5'
```
Expected: `backup ok: db_... (N bytes)`, `all green (...)`, files present, both healthchecks.io checks now "up".

- [ ] **Step 5: Break the probe on purpose and confirm it fails**

An alert that has never fired is not an alert.

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose stop auth && sleep 2 && \
  /srv/supabase/healthprobe.sh; echo "exit=$?"; docker compose start auth'
```
Expected: prints `auth down`, `exit=1`, and does **not** ping. Leaving it stopped past the grace window would raise the alert — verify at least that the probe fails.

- [ ] **Step 6: Perform the restore drill and time it**

Follow `ops/supabase/restore-drill.md` against a `-p sbdrill` project on unused ports. Assert `auth.users` count matches and one attachment downloads. Record the wall-clock minutes.

- [ ] **Step 7: Record the measured RTO and commit**

```bash
git add ops/supabase/restore-drill.md
git commit -m "ops: restore drill performed — RTO <N> minutes

Backups run nightly to an encrypted B2 remote with a dead-man's switch;
the health probe was verified by stopping auth and watching it fail."
```

---

### Task 9: Cutover

**Files:**
- Server: `/srv/apps/crm-icc/.env.local`
- Modify: `.env.example` (document the new URL shape)

**Interfaces:**
- Consumes: `ANON_KEY`, `SERVICE_ROLE_KEY` from `/srv/supabase/.env`.
- Produces: the app running against the self-hosted stack.

- [ ] **Step 1: Announce the window and stop the app**

```bash
ssh root@72.62.42.52 'systemctl stop crm-icc && systemctl is-active crm-icc'
```
Expected: `inactive`. Everyone is signed out by the key change anyway, so a short hard stop is simpler than a read-only mode.

- [ ] **Step 2: Take the final dumps and restore into a freshly recreated stack**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && docker compose down && \
  rm -rf volumes/db/data && mkdir -p volumes/db/data && docker compose up -d && sleep 45 && docker compose ps'
ssh root@72.62.42.52 "cd /srv/supabase && CLOUD_DB_URL='<url>' bash migrate-from-cloud.sh 2>&1 | tail -20"
```
Then repeat Task 7 steps 5–9 (publication, storage copy, parity, grants, password check). **Wiping `volumes/db/data` discards the rehearsal data — that is intended, so the cutover starts from a clean restore.**

- [ ] **Step 3: Point the app at the self-hosted stack**

```bash
ssh root@72.62.42.52 'cd /srv/supabase && set -a; . ./.env; set +a
cp /srv/apps/crm-icc/.env.local /root/env.local.cloud-backup-$(date +%F)
cd /srv/apps/crm-icc
sed -i "s|^NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=https://iccdesk.duckdns.org/sb|" .env.local
sed -i "s|^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*|NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY|" .env.local
sed -i "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" .env.local
grep -c . .env.local; cut -d= -f1 .env.local'
```
The cloud values are kept at `/root/env.local.cloud-backup-*` — that file is the rollback.

- [ ] **Step 4: Rebuild and start (env vars are inlined at build time)**

`NEXT_PUBLIC_*` values are baked into the client bundle by `next build`, so a restart alone is not enough.

```bash
ICC_SSH_PASS='...' bash scripts/deploy.sh
```
Expected: `health: HTTP 307`, `deployed <sha>`.

- [ ] **Step 5: Confirm the browser bundle points at the new API**

```bash
curl -s https://iccdesk.duckdns.org/login | grep -o 'iccdesk.duckdns.org/sb' | head -1
curl -s https://iccdesk.duckdns.org/login | grep -c 'mmvpbomvmgbceqmjwrpv.supabase.co'
```
Expected: the first prints a match, the second prints `0`. A non-zero second number means a stale build.

- [ ] **Step 6: Smoke test the whole app against the self-hosted stack**

Run the existing end-to-end harness, which covers exactly these paths:

```bash
cd <scratchpad>/e2e && BASE=https://iccdesk.duckdns.org node audit5.mjs
```
Expected: the same pass profile as against cloud. Then by hand, as a real user: sign in with an **unchanged** password, open a room, send a message and see it arrive in a second browser, upload and open an attachment, and place a call.

- [ ] **Step 7: Commit and record the point of no return**

```bash
git add .env.example
git commit -m "cutover: app now runs on the self-hosted Supabase stack

Cloud project left untouched as the rollback until <date + 14 days>.
Data written after this commit exists only on the VPS, so a rollback past
this point loses it."
```

---

### Task 10: Post-cutover hardening

**Files:**
- Server: `/etc/ssh/sshd_config`, `/etc/fail2ban/jail.local`, `/etc/apt/apt.conf.d/20auto-upgrades`, ufw rules
- Modify: `scripts/deploy.sh` (drop the password path once keys work)

**Interfaces:**
- Consumes: a working cutover.
- Produces: a box whose only public ports are 22, 80, 443 and TURN.

- [ ] **Step 1: Install an SSH key and verify it in a second session**

The current root password is compromised; it must stop being an access path. **Keep the existing session open** until the key is proven.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/icc_vps_ed25519 -C "icc-deploy"
ssh-copy-id -i ~/.ssh/icc_vps_ed25519.pub root@72.62.42.52
ssh -i ~/.ssh/icc_vps_ed25519 -o PasswordAuthentication=no root@72.62.42.52 'echo key-login-works'
```
Expected: `key-login-works`.

- [ ] **Step 2: Disable password authentication**

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'sed -i \
  -e "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" \
  -e "s/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/" \
  -e "s/^#*KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/" \
  /etc/ssh/sshd_config && sshd -t && systemctl restart ssh && echo restarted'
ssh -o PubkeyAuthentication=no root@72.62.42.52 'echo SHOULD NOT PRINT' || echo "password auth correctly refused"
```

- [ ] **Step 3: Close the pre-existing public ports found during measurement**

`0.0.0.0:5432` (other app's Postgres), `0.0.0.0:3000` (node), `3389` (xrdp) are reachable from the internet.

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'ufw default deny incoming; ufw default allow outgoing
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 3478/tcp; ufw allow 3478/udp
ufw --force enable; ufw status verbose'
```
From your workstation, confirm each is refused: `for p in 5432 3000 3389; do nc -z -w3 72.62.42.52 $p && echo "$p STILL OPEN" || echo "$p closed"; done`.
Then verify the app, TURN and the trading bots still work — ufw must not have broken them.

- [ ] **Step 4: fail2ban and unattended-upgrades**

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'apt-get install -y fail2ban unattended-upgrades
cat > /etc/fail2ban/jail.local <<JAIL
[sshd]
enabled = true
banaction = ufw
maxretry = 4
findtime = 10m
bantime = 24h
JAIL
systemctl enable --now fail2ban && fail2ban-client status sshd
cat > /etc/apt/apt.conf.d/20auto-upgrades <<AUTO
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTO
echo done'
```

- [ ] **Step 5: Switch the deploy script to key auth**

```bash
ICC_SSH_KEY=~/.ssh/icc_vps_ed25519 bash scripts/deploy.sh
```
Correct the path to `~/.ssh/icc_vps_ed25519` (the script already supports `ICC_SSH_KEY`). Expected: a successful deploy without any password.

- [ ] **Step 6: Update the runbook and commit**

```bash
git add docs/RUNBOOK.md scripts/deploy.sh
git commit -m "ops: harden the box after cutover

SSH key auth only (the old root password is retired), ufw closes the
pre-existing public Postgres/node/xrdp ports, fail2ban and unattended
upgrades enabled. Deploys now use ICC_SSH_KEY."
```

---

## Self-Review

**Spec coverage:** stack pruning + Postgres 17 → Task 1; loopback + DOCKER-USER → Tasks 1, 4, 10; `/sb/` prefix + WebSocket → Task 6; key derivation → Task 5; migration incl. password portability, publication repair, S3 file copy, grants → Task 7; backups/off-box/alerting/restore drill → Tasks 2, 8; runbook → Tasks 3, 8; cutover + rollback + smoke test → Task 9; pre-existing exposed ports → Task 10; WAL/disk guardrails → Tasks 1 (`max_slot_wal_keep_size`), 2 (probe), 8 (alerting). Out-of-scope items (Edge Functions, analytics, Supavisor, replicas) have no tasks, as intended.

**Placeholders:** the deliberate ones are values only the operator can supply — the cloud database password (Task 7 Step 1), the two healthchecks UUIDs (Task 8 Step 3), the B2 application key and crypt passwords (Task 8 Step 1), and the pinned upstream tag if `self-hosted/v0.7.0` has moved (Task 1 Step 1). Each says how to obtain it.

**Type/name consistency:** env var names in `.env.example` (Task 1) match `generate-secrets.sh` (Task 5), `healthprobe.sh` (Task 2) and the cutover `sed` commands (Task 9): `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`. Paths are consistent throughout: `/srv/supabase`, `/srv/apps/crm-icc`, `/var/backups/supabase`. Service names (`db`, `auth`, `rest`, `realtime`, `storage`, `kong`) are identical in Tasks 1, 4, 5, 8.

**Known risk carried forward:** Task 1 Step 2 exists because a pruned service that another still `depends_on` is the most likely cause of a failed first boot; if that happens, restore the dependency or set the dependent's condition to `service_started`.
