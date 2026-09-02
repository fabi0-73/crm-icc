# Restore drill

A backup nobody has restored is a hope, not a backup. Run this once before
cutover and every six months after. The number you write at the bottom is
the recovery time you can actually promise.

The drill restores into a **throwaway stack** (`-p sbdrill`) on unused
ports. It never touches the running stack, so it is safe to do on a normal
working day.

## 1. Fetch the newest off-box backup

```bash
mkdir -p /root/drill && cd /root/drill
rclone lsl b2crypt:icc-backups | sort -k4 | tail -5
rclone copy b2crypt:icc-backups/db_<STAMP>.dump      /root/drill/
rclone copy b2crypt:icc-backups/storage_<STAMP>.tgz  /root/drill/
rclone copy b2crypt:icc-backups/env_<STAMP>          /root/drill/
```

Pulling from B2 rather than `/var/backups` is the point: it proves the
off-box copy is complete and the crypt passphrase still works.

## 2. Start a throwaway stack

```bash
mkdir -p /srv/sbdrill && cp -r /srv/supabase/{docker-compose.yml,volumes} /srv/sbdrill/
cp /root/drill/env_<STAMP> /srv/sbdrill/.env
cd /srv/sbdrill
rm -rf volumes/db/data volumes/storage && mkdir -p volumes/db/data volumes/storage
sed -i 's|127.0.0.1:8000:8000|127.0.0.1:8010:8000|' docker-compose.yml
docker compose -p sbdrill up -d && sleep 45 && docker compose -p sbdrill ps
```

## 3. Restore the database

```bash
cd /srv/sbdrill
docker compose -p sbdrill exec -T db pg_restore -U supabase_admin -d postgres \
  --clean --if-exists --no-owner < /root/drill/db_<STAMP>.dump 2>&1 | tail -20
```

Errors mentioning roles that already exist are expected and harmless.
Anything mentioning a **missing table or column** is not — stop and
investigate, that is the drill earning its keep.

## 4. Restore the files

```bash
tar xzf /root/drill/storage_<STAMP>.tgz -C /srv/sbdrill/volumes/
ls /srv/sbdrill/volumes/storage | head
```

## 5. Assert it is actually usable

Three checks. All three must pass.

```bash
cd /srv/sbdrill
# a) the people are there
docker compose -p sbdrill exec -T db psql -U supabase_admin -d postgres -tAc \
  "select count(*) from auth.users"

# b) an existing password still authenticates against the restored data
set -a; . ./.env; set +a
curl -s -X POST "http://127.0.0.1:8010/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"<a known account>@iccdesk.duckdns.org","password":"<its password>"}' \
  | head -c 120

# c) an attachment downloads
docker compose -p sbdrill exec -T db psql -U supabase_admin -d postgres -tAc \
  "select name from storage.objects where bucket_id='attachments' limit 1"
```

Expected: a count matching production, a JSON body containing
`access_token`, and a filename. If (b) fails the auth schema did not
survive, which means the backup is not restorable — fix that before
anything else.

## 6. Tear down

```bash
cd /srv/sbdrill && docker compose -p sbdrill down -v
cd / && rm -rf /srv/sbdrill /root/drill
```

`-v` removes the drill's volumes. Check you are in `sbdrill` and not the
real stack before running it.

## Record

Time from step 1 to a passing step 5. That is the RTO — how long the app
is down if the VPS is lost.

| Drill date | Restored in | Backup used | Notes |
| --- | --- | --- | --- |
| _not yet run_ | — | — | fill in during Task 8 |
