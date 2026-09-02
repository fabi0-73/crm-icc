# ICC Desk — Operator Runbook

The self-hosted stack, for one person at 3am. Terse on purpose. Every command is
copy-pasteable; the only blanks are values only you can hold, marked
`<from password manager>`.

**Rules that never bend**

- This repository is **public**. Never paste a key, password or token into a file here.
  Real values live only in `/srv/supabase/.env` and `/srv/apps/crm-icc/.env.local`, both
  `chmod 600`, root-owned.
- **The box is shared.** Unrelated trading bots and their Postgres instances run on
  `127.0.0.1:5433` (PG14) and `:5432` (PG16). **Never restart, stop or `apt` those.**
  Nothing in this runbook touches them; if a command you are about to improvise would,
  stop.
- Nothing new may listen on a public interface. Every container port binds `127.0.0.1`;
  the only public entrance is nginx on 443.

---

## 1. Inventory

| Thing | Value |
| --- | --- |
| VPS | `72.62.42.52`, Ubuntu 22.04, 7.8 GB RAM, 2 vCPU, 97 GB disk |
| Public hostname | `https://iccdesk.duckdns.org` (DuckDNS + Let's Encrypt via certbot) |
| SSH | `ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52` (key only after hardening) |
| App | `crm-icc.service` → Next.js on `127.0.0.1:3010`, code at `/srv/apps/crm-icc` |
| Supabase stack | `supabase.service` → Docker Compose at `/srv/supabase`, gateway on `127.0.0.1:8000` |
| API from the browser | `https://iccdesk.duckdns.org/sb/` → nginx → kong `127.0.0.1:8000` |
| Containers | `db` (Postgres 17), `auth` (GoTrue), `rest` (PostgREST), `realtime`, `storage`, `kong` |
| **Not ours** | PG14 `127.0.0.1:5433`, PG16 `:5432`, coturn `:3478`, xrdp, tor — trading bots and infra |

**Ports — the only public ones are 22, 80, 443, 3478.** Everything Supabase is loopback.

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'ss -tlnp | grep LISTEN'
```

Expect `8000` bound to `127.0.0.1` only. From your workstation this must **fail to connect**:

```bash
curl -m 5 http://72.62.42.52:8000/
```

**Env files**

| File | Holds | Perms |
| --- | --- | --- |
| `/srv/supabase/.env` | `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY` | `600`, root |
| `/srv/apps/crm-icc/.env.local` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `600`, root |
| `/root/env.local.cloud-backup-*` | the pre-cutover cloud values — this is the rollback | `600`, root |

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 \
  'ls -l /srv/supabase/.env /srv/apps/crm-icc/.env.local /root/env.local.cloud-backup-*; \
   cut -d= -f1 /srv/supabase/.env'
```

`cut -d= -f1` prints **names only** — never `cat` these files into a terminal you might screenshot.

**Credentials that are not on the box.** The following exist **only in the owner's password
manager**. Losing them is unrecoverable in the case of the first two:

- **rclone B2 crypt passwords** (password + salt for the `b2crypt` remote) — without them
  every off-box backup is permanently unreadable.
- **Backblaze B2 application key**.
- **healthchecks.io ping URLs** for `icc-supabase-backup` and `icc-supabase-health`
  (also present on the box in `/etc/cron.d/supabase-ops`, `chmod 600`).
- **DuckDNS token**, **VPS provider console login** — see §12.

---

## 2. Start / stop / status

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'systemctl status supabase --no-pager'
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'systemctl status crm-icc --no-pager'
```

```bash
# The whole Supabase stack (oneshot unit: ExecStart = docker compose up -d)
systemctl start supabase
systemctl stop supabase
systemctl restart supabase

# The Next.js app
systemctl start crm-icc
systemctl stop crm-icc
systemctl restart crm-icc
```

Per-container truth, always from the stack directory:

```bash
cd /srv/supabase && docker compose ps
```

Expect exactly six: `auth`, `db`, `kong`, `realtime`, `rest`, `storage` — all `running`,
none restarting.

One service at a time (does not touch the others):

```bash
cd /srv/supabase && docker compose restart auth
cd /srv/supabase && docker compose up -d --force-recreate rest
```

Is it actually serving?

```bash
cd /srv/supabase && set -a; . ./.env; set +a
curl -s http://127.0.0.1:8000/auth/v1/health; echo
curl -s -o /dev/null -w 'rest:%{http_code}\n' -H "apikey: $ANON_KEY" http://127.0.0.1:8000/rest/v1/
curl -s -o /dev/null -w 'app:%{http_code}\n' https://iccdesk.duckdns.org/login
```

Expect GoTrue version JSON, `rest:200`, `app:200`.

Or just run the probe that cron runs, by hand:

```bash
/srv/supabase/healthprobe.sh; echo "exit=$?"
```

Expect `all green (disk N%, slot lag N)` and `exit=0`. Run without `HEALTH_PING_URL` set
so a manual run does not falsely satisfy the dead-man's switch.

---

## 3. Where the data is

| What | Path | Notes |
| --- | --- | --- |
| Postgres data directory | `/srv/supabase/volumes/db/data` | wiping this destroys the database |
| Attachments (Storage API) | `/srv/supabase/volumes/storage` | the Storage API owns this layout — never copy files in by hand |
| Nightly backups, 14 days | `/var/backups/supabase` | `db_*.dump`, `roles_*.sql.gz`, `storage_*.tgz`, `env_*` |
| Off-box, encrypted | rclone remote `b2crypt:icc-backups` | Backblaze B2, crypt remote, passwords in the password manager |

```bash
ls -lh /var/backups/supabase | tail -10
df -h /
du -sh /srv/supabase/volumes/db/data /srv/supabase/volumes/storage
rclone size b2crypt:icc-backups
```

Backups are written nightly at 03:15 by `/etc/cron.d/supabase-ops`. Force one now:

```bash
BACKUP_PING_URL=$(grep BACKUP_PING_URL /etc/cron.d/supabase-ops | cut -d= -f2-) \
  /srv/supabase/backup.sh
```

Expect `backup ok: db_<stamp>.dump (N bytes)`. The script refuses to finish if the dump is
under 20 000 bytes — a truncated dump is worse than none.

---

## 4. Restore

The full, tested procedure is **`ops/supabase/restore-drill.md`** (also on the box at
`/srv/supabase/restore-drill.md`). Follow it verbatim; it restores the newest off-box dump
into a throwaway `docker compose -p sbdrill` project on unused ports, then asserts
`select count(*) from auth.users` matches production and that one attachment downloads.

> **Last drill: ___ — restored in ___ minutes.**
>
> **That number is the RTO.** It is what you tell people when they ask how long the app
> will be down. It is a measurement, not a guess — if the line above is still blank, you do
> not have an RTO, you have a hope. Fill it in from Task 8 Step 6 and re-fill it after every
> drill.

Fetch the newest off-box backup:

```bash
rclone lsl b2crypt:icc-backups | sort -k2 | tail -5
mkdir -p /root/restore && rclone copy b2crypt:icc-backups /root/restore --include 'db_*' --max-age 48h
```

Restoring **over production** (only when the live database is already lost — this overwrites
it):

```bash
systemctl stop crm-icc
cd /srv/supabase
zcat /var/backups/supabase/roles_<stamp>.sql.gz | docker compose exec -T db psql -U postgres -d postgres
docker compose exec -T db pg_restore -U postgres -d postgres --clean --if-exists --no-owner \
  < /var/backups/supabase/db_<stamp>.dump
tar xzf /var/backups/supabase/storage_<stamp>.tgz -C /srv/supabase/volumes
docker compose restart storage realtime rest auth
systemctl start crm-icc
```

Then re-check §10's publication and grants queries before telling anyone it is back.

---

## 5. Rotate the JWT secret

**Consequence, say it out loud first: every session is invalidated and every user signs in
again.** Passwords still work — they are bcrypt hashes, independent of the JWT secret — so
nobody has to reset anything. But everyone gets logged out. Do this in a window, not at
09:00.

`ANON_KEY` and `SERVICE_ROLE_KEY` are **not random strings**. They are HS256 JWTs signed
with `JWT_SECRET`, carrying `{"iss":"supabase","role":"anon"}` and
`{"iss":"supabase","role":"service_role"}`. Putting a random value in either produces a
stack that starts and then 401s every request.

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'bash -s' <<'ROTATE'
set -euo pipefail
cd /srv/supabase
cp -a .env ".env.bak-$(date +%F_%H%M)"

JWT_SECRET=$(openssl rand -hex 32)

# Same signing routine as ops/supabase/generate-secrets.sh.
mkjwt() {
  local role="$1" now exp header payload sig
  now=$(date +%s); exp=$((now + 315360000))
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  payload=$(printf '{"iss":"supabase","role":"%s","iat":%s,"exp":%s}' "$role" "$now" "$exp" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  sig=$(printf '%s.%s' "$header" "$payload" \
    | openssl dgst -binary -sha256 -hmac "$JWT_SECRET" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}
ANON_KEY=$(mkjwt anon)
SERVICE_ROLE_KEY=$(mkjwt service_role)

sed -i -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
       -e "s|^ANON_KEY=.*|ANON_KEY=$ANON_KEY|" \
       -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" .env
chmod 600 .env

# Same three values in the app's env.
cd /srv/apps/crm-icc
cp -a .env.local ".env.local.bak-$(date +%F_%H%M)"
sed -i -e "s|^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*|NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY|" \
       -e "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" .env.local
chmod 600 .env.local
echo "rotated"
ROTATE
```

Verify the new keys actually verify against the new secret **before** recreating anything:

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'cd /srv/supabase && set -a; . ./.env; set +a
python3 - <<PY
import base64,hmac,hashlib,json,os
def check(tok, secret):
    h,p,s = tok.split(".")
    expect = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    payload = json.loads(base64.urlsafe_b64decode(p + "=="*((4-len(p)%4)%4)))
    return s == expect, payload["role"]
for name in ("ANON_KEY","SERVICE_ROLE_KEY"):
    ok, role = check(os.environ[name], os.environ["JWT_SECRET"])
    print(name, "signature", "OK" if ok else "BAD", "role", role)
PY'
```

Both must print `signature OK` with roles `anon` and `service_role`. **If either says BAD,
restore `.env.bak-*` and stop.**

Recreate the stack so every container picks up the new secret:

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 \
  'cd /srv/supabase && docker compose up -d --force-recreate && sleep 30 && docker compose ps'
```

**Rebuild the app — a restart is not enough.** `NEXT_PUBLIC_*` values are inlined into the
client bundle by `next build`, so the browser keeps sending the old anon key until the
bundle is rebuilt:

```bash
ICC_SSH_KEY=~/.ssh/icc_vps_ed25519 bash scripts/deploy.sh
```

Confirm end to end:

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'cd /srv/supabase && set -a; . ./.env; set +a
curl -s -o /dev/null -w "rest:%{http_code}\n" -H "apikey: $ANON_KEY" http://127.0.0.1:8000/rest/v1/'
curl -s -o /dev/null -w 'app:%{http_code}\n' https://iccdesk.duckdns.org/login
```

Then sign in in a browser. Everyone else must sign in again too — that is expected, not a
fault.

> **If `/rest/v1/` 401s with a freshly-verified anon key:** the database may still hold the
> old secret as a database-level setting. Supabase's init scripts set it only on first
> initialisation of the data directory, so a rotation does not reach it. Check, then
> re-apply it sourcing from `.env` so the secret is never typed:
>
> ```bash
> cd /srv/supabase && docker compose exec -T db psql -U supabase_admin -d postgres -c \
>   "select current_setting('app.settings.jwt_secret', true) is not null as db_copy_exists"
> ```
>
> (That prints `t`/`f`, never the value.) If it is `t`, the database has its own copy and it
> is stale — overwrite it:
>
> ```bash
> cd /srv/supabase && set -a; . ./.env; set +a
> docker compose exec -T db psql -U supabase_admin -d postgres \
>   -c "alter database postgres set \"app.settings.jwt_secret\" to '$JWT_SECRET'"
> docker compose restart rest realtime storage auth
> ```

---

## 6. Add a user

**Normal path — through the app.** `https://iccdesk.duckdns.org/admin/users` → **New user**.
Full name, username, role (Admin / Manager / Assistant); leave the password blank to
auto-generate a readable one. **The password is shown exactly once** — copy it before
closing the dialog. Agent accounts are created from the Agents page, not here.

**Only if the app is down.** Two records are needed: a GoTrue user *and* a `public.profiles`
row. The app writes both; doing one without the other produces an account that signs in to
nothing.

Usernames map to `<username>@iccdesk.duckdns.org`. **Those mailboxes do not exist** — never
use a flow that needs email delivery.

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'bash -s' <<'ADDUSER'
set -euo pipefail
USERNAME=newperson              # lowercase, 2-32 chars, letters/digits/dot/dash
FULL_NAME="New Person"
ROLE=assistant                  # admin | manager | assistant
PASSWORD='<choose one, >=8 chars, hand it over in person>'

cd /srv/supabase && set -a; . ./.env; set +a
UID_JSON=$(curl -s -X POST http://127.0.0.1:8000/auth/v1/admin/users \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USERNAME@iccdesk.duckdns.org\",\"password\":\"$PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"$FULL_NAME\",\"username\":\"$USERNAME\"}}")
echo "$UID_JSON" | head -c 200; echo
NEW_ID=$(echo "$UID_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "insert into public.profiles (id, full_name, role, is_active) \
      values ('$NEW_ID', '$FULL_NAME', '$ROLE', true)"
echo "created $USERNAME ($NEW_ID)"
ADDUSER
```

**Never `INSERT` into `auth.users` directly.** GoTrue owns that schema; a hand-written row
misses the identity record and the bcrypt format GoTrue expects, and the account will not
sign in. Always go through the admin API.

Verify:

```bash
cd /srv/supabase && set -a; . ./.env; set +a
curl -s -X POST "http://127.0.0.1:8000/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"newperson@iccdesk.duckdns.org","password":"<the password you set>"}' | head -c 120
```

Expect a body containing `access_token`.

---

## 7. Delete a user

`https://iccdesk.duckdns.org/admin/users` → **Delete** on the row.

The dialog fetches and lists exactly what will be destroyed before you can confirm: messages
they sent (removed from every conversation), their workspace and its messages, direct chats
they were in, their place in shared conversations. It also lists what survives — shared
channels and groups they set up, which move to you, plus their audit entries. If the account
has a real footprint you must type the username to confirm.

**Deactivate is almost always the right choice.** For someone who merely left, use
**Deactivate** on the same row: the login stops working, the person shows as *Inactive*, and
their history stays readable in every conversation. Deletion is for accounts created in
error or that must be erased. It cannot be undone.

There is no supported command-line deletion path. If the app is down, wait — deleting a user
by hand means reconciling `auth.users`, `public.profiles`, room memberships and messages
yourself, and getting it wrong corrupts other people's conversations.

---

## 8. Logs

```bash
cd /srv/supabase
docker compose logs -f db
docker compose logs -f auth
docker compose logs -f rest
docker compose logs -f realtime
docker compose logs -f storage
docker compose logs -f kong

# Several at once, last 100 lines, no follow:
docker compose logs --tail 100 auth storage
```

Container logs are capped at 10 MB × 3 files by `/etc/docker/daemon.json`, so they cannot
fill the disk.

```bash
journalctl -u crm-icc -f                 # the Next.js app
journalctl -u crm-icc --since '1 hour ago' --no-pager
journalctl -u supabase -n 50 --no-pager  # the compose unit itself (start/stop only)
```

```bash
tail -f /var/log/nginx/error.log         # TLS, proxying, /sb/ routing
tail -50 /var/log/supabase-backup.log    # nightly backup
tail -50 /var/log/supabase-health.log    # 5-minute probe
tail -50 /var/log/rclone-backup.log      # off-box sync
```

---

## 9. Deploy the app

From the repo on your workstation, in Git Bash. It deploys **committed state** — `git archive`
of `HEAD`, not your working tree:

```bash
ICC_SSH_KEY=~/.ssh/icc_vps_ed25519 bash scripts/deploy.sh
```

What it does: archives `HEAD` → copies to the server → `npm ci` → `npx next build` on the
server → `systemctl restart crm-icc` → polls `http://127.0.0.1:3010/` until it answers.

Expect it to end with `health: HTTP 307` (or `200`) and `deployed <sha> to 72.62.42.52`.

- The server's `.env.local` is **never** touched — it is not in the archive.
- Uncommitted changes are **not** deployed; the script warns and continues. Commit first.
- Any change to `NEXT_PUBLIC_*` requires this deploy, not a restart — those values are
  inlined at build time.

If it fails at the health check, the new code is already on the box and the unit is
restarting. Read `journalctl -u crm-icc -n 100 --no-pager` before re-running.

---

## 10. Common failures

### A container restart-loops after an image bump

Almost always a **failed schema migration**. GoTrue and Storage run their own migrations at
boot; an image whose migrations do not apply cleanly crashes, restarts, and crashes again.

```bash
cd /srv/supabase && docker compose ps
cd /srv/supabase && docker compose logs auth storage --tail 200 | grep -iE 'migrat|error|fatal'
```

Read the **first** error, not the last. Fix: pin the previous tag in
`/srv/supabase/docker-compose.yml`, `docker compose up -d --force-recreate <service>`, and
note that **an image rollback does not roll back applied schema migrations** — if the
migration partly ran, restore from backup (§4) rather than fighting it.

### Disk filling — a replication slot pinning WAL

**This is the documented way this stack dies,** and because the disk is shared it would take
the trading bots' Postgres down with it. The health probe watches for it; check by hand:

```bash
df -h /
cd /srv/supabase && docker compose exec -T db psql -U supabase_admin -d postgres -c \
  "select slot_name, active, wal_status,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained
     from pg_replication_slots"
du -sh /srv/supabase/volumes/db/data
```

A slot that is `active = f` with `retained` in the hundreds of MB and climbing is the
culprit. `max_slot_wal_keep_size=512MB` in the db command means Postgres marks such a slot
`lost` rather than filling the disk — but if realtime is flapping, fix realtime:

```bash
cd /srv/supabase && docker compose logs --tail 100 realtime
cd /srv/supabase && docker compose restart realtime
```

Only if a slot is genuinely orphaned (`wal_status = lost`, no consumer, realtime healthy
without it) drop it — realtime recreates its own on next start:

```bash
cd /srv/supabase && docker compose exec -T db psql -U supabase_admin -d postgres -c \
  "select pg_drop_replication_slot('<slot_name from the query above>')"
cd /srv/supabase && docker compose restart realtime
```

Never drop a slot belonging to the trading bots' Postgres — that is a **different server**
on `:5432`/`:5433` and this command cannot reach it. Confirm you are inside
`/srv/supabase`'s `db` container before dropping anything.

### The app shows empty rooms

The `private` schema grants did not survive a restore. Every RLS policy calls
`private.*` helpers; without `usage` they fail closed and every room list comes back empty.

```bash
cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres \
  -c "select has_schema_privilege('authenticated','private','usage') as private_usage" \
  -c "select proname, pg_get_userbyid(proowner) as owner from pg_proc
        where pronamespace = 'private'::regnamespace order by 1"
```

Expect `private_usage = t` and the `private.*` functions listed. If it is `f`:

```bash
cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres \
  -c "grant usage on schema private to authenticated, service_role"
```

### Realtime silently delivers nothing

No error anywhere — messages just never arrive in the second browser. The publication is
empty. The Supabase CLI comments `CREATE PUBLICATION supabase_realtime` out of its dump, so
a restore can leave it with no tables.

```bash
cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres -c \
  "select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime'"
```

It **must** list `public.messages` and `public.call_signals`. If not:

```bash
cd /srv/supabase && docker compose exec -T db psql -U postgres -d postgres \
  -c "alter publication supabase_realtime add table public.messages" \
  -c "alter publication supabase_realtime add table public.call_signals"
cd /srv/supabase && docker compose restart realtime
```

`already member of publication` is fine — it means that table was already there.

Also check `wal_level` is `logical`, without which realtime cannot work at all:

```bash
cd /srv/supabase && docker compose exec -T db psql -U supabase_admin -d postgres -c 'show wal_level'
```

### WebSockets connect and immediately drop

nginx is not passing the upgrade. From your workstation:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://iccdesk.duckdns.org/sb/realtime/v1/websocket?apikey=<ANON_KEY>&vsn=1.0.0'
```

`101` is correct. `200` or `400` means the `/sb/` location lost its `proxy_set_header
Upgrade` / `Connection $connection_upgrade` lines:

```bash
nginx -t && systemctl reload nginx
```

---

## 11. Roll back to Supabase Cloud

**Valid only inside the 14-day window after cutover, and only while the cloud project is
still untouched.**

**Everything written on the self-hosted stack after the cutover is lost.** Messages,
attachments, new accounts — all of it. The cloud project holds the data as it stood at
cutover and nothing since. This is not reversible by trying again; decide deliberately.

Three env vars in `/srv/apps/crm-icc/.env.local` revert:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

The saved copy is `/root/env.local.cloud-backup-<date>`, written by the cutover.

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 'ls -l /root/env.local.cloud-backup-*'
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 \
  'cp -a /srv/apps/crm-icc/.env.local /root/env.local.selfhosted-$(date +%F_%H%M) && \
   install -m 600 -o root -g root /root/env.local.cloud-backup-<date> /srv/apps/crm-icc/.env.local && \
   cut -d= -f1 /srv/apps/crm-icc/.env.local'
```

Then **redeploy** — a restart is not enough, the anon key and URL are inlined at build time:

```bash
ICC_SSH_KEY=~/.ssh/icc_vps_ed25519 bash scripts/deploy.sh
```

Confirm the browser bundle no longer points at the self-hosted API:

```bash
curl -s https://iccdesk.duckdns.org/login | grep -c 'iccdesk.duckdns.org/sb'
```

Expect `0`. A non-zero count means the build was stale — deploy again.

The Supabase stack can keep running; leaving it up costs nothing and preserves the data you
just orphaned, in case you change your mind about salvaging any of it.

---

## 12. Escalation

**The whole box is unreachable** (SSH times out, the site is down, healthchecks.io fired
both checks). This is the VPS provider's console, not something SSH can fix:

- Log in to the VPS provider's control panel — credentials `<from password manager>`.
- Use its **web/serial console** to get a shell without SSH; check `df -h /` first (a full
  disk is the most likely cause — see §10).
- Reboot from the panel only as a last resort. It restarts the trading bots too. `supabase`
  and `crm-icc` are both `systemctl enable`d and come back on their own.

**DNS.** `iccdesk.duckdns.org` is a DuckDNS record. The token is `<from password manager>`;
sign in at <https://www.duckdns.org> with the owner's account to see or update the record.
If an updater runs on the box, it is a cron entry — find it before assuming there is none:

```bash
grep -rl duckdns /etc/cron.d /etc/cron.daily /var/spool/cron 2>/dev/null
crontab -l
systemctl list-timers --all --no-pager | grep -i duck
```

The IP is static, so DNS rarely moves; if the name stops resolving, check DuckDNS before
suspecting the server.

**TLS.** The certificate is Let's Encrypt via **certbot, renewed automatically by a systemd
timer**. There is one certificate covering `iccdesk.duckdns.org`, shared by the app and
`/sb/` — that is why the API is a path prefix and not a subdomain.

```bash
systemctl list-timers --no-pager | grep -i certbot
certbot certificates
certbot renew --dry-run
```

If renewal is failing, it is almost always port 80 being blocked or nginx not serving the
ACME challenge. Check `ufw status verbose` shows `80/tcp ALLOW`, then
`tail -50 /var/log/letsencrypt/letsencrypt.log`.

**Alerting.** healthchecks.io is the source of truth for "did it break while I was asleep".
Two checks: `icc-supabase-backup` (daily, 6h grace) and `icc-supabase-health` (5 min, 15 min
grace). If a check is red but the app is fine, run the corresponding script by hand (§2, §3)
and read its output — the probe failing is itself information.

**Before escalating anywhere, capture the state.** It is much harder to reconstruct after a
reboot:

```bash
ssh -i ~/.ssh/icc_vps_ed25519 root@72.62.42.52 \
  'date; uptime; free -h; df -h /; systemctl is-active crm-icc supabase nginx docker; \
   cd /srv/supabase && docker compose ps'
```
