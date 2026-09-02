# Self-hosted Supabase on the ICC VPS

**Date:** 2026-09-02
**Status:** approved (approach), pending implementation
**Owner:** solo operator — every choice below optimises for "survivable by one person"

## Why

The backend is a Supabase Cloud **free-tier** project (`mmvpbomvmgbceqmjwrpv`, Postgres 17,
eu-central-1). Free projects pause after ~1 week idle; on 2026-08-21 that took the entire
app down until the project was restored by hand. The owner wants the database on their own
VPS, self-sustaining.

## Measured starting point (2026-09-02)

| Fact | Value |
| --- | --- |
| RAM | 7.8 GB total, 6.8 GB available |
| CPU | 2 vCPU |
| Disk | 97 GB, 62 GB free (37% used) |
| Docker | not installed |
| Existing Postgres | v14 on `127.0.0.1:5433`, v16 on `0.0.0.0:5432` (other apps) |
| Also running | nginx + Let's Encrypt, `crm-icc.service` on `127.0.0.1:3010`, coturn `:3478`, xrdp `:3389`, tor |
| Live data to move | 13 auth users, 9 rooms, ~50 messages, a handful of attachments |

The minimal Supabase stack idles at roughly 0.7–1.2 GB, so RAM is not the constraint.
**Disk and the 2 shared vCPUs are.**

### Pre-existing exposure found while measuring (fix as part of this work)

- `0.0.0.0:5432` — the other app's Postgres 16 is reachable from the internet.
- `0.0.0.0:3000` — a node process listening on all interfaces.
- `0.0.0.0:3389` — xrdp.

These are not caused by this project but share the blast radius, so the hardening step
covers them.

## Architecture

```
Internet ──443──► nginx (existing cert, iccdesk.duckdns.org)
                   ├── /            → 127.0.0.1:3010   Next.js app (unchanged)
                   └── /sb/         → 127.0.0.1:8000   Supabase gateway
                                                        ├── /auth/v1   GoTrue
                                                        ├── /rest/v1   PostgREST
                                                        ├── /realtime/v1 (WebSocket)
                                                        └── /storage/v1 Storage API
                                                              │
                                                        Postgres 17 (container, not published)
```

**Nothing new is exposed to the internet.** Every container port binds to `127.0.0.1`;
the only public entrance stays nginx on 443.

### Why a path prefix, not `api.iccdesk.duckdns.org`

DuckDNS sub-subdomains do resolve, but they inherit the parent record and add a second
certificate plus a second renewal path that can silently break. The prefix reuses the
existing certificate and certbot timer untouched. **`/api/` is not available** — Next.js
owns that route namespace — so the prefix is **`/sb/`**.

Client config becomes `NEXT_PUBLIC_SUPABASE_URL=https://iccdesk.duckdns.org/sb`.

### Services: six, not fourteen

Kept: `db` (Postgres 17), `auth` (GoTrue), `rest` (PostgREST), `realtime`, `storage`,
`kong` (gateway).

Dropped: `studio`, `meta`, `edge-functions`, `imgproxy`, `vector`, `supavisor`, and
above all **`analytics` (Logflare)**. Supabase's own docs sanction pruning, and analytics
is opt-in since 2026-06-03 precisely because it is the heavy one — it is implicated in
reported OOMs at 2 GB and in a runaway-WAL incident that consumed 745 GB.

Postgres 17 matches the cloud project, so dumps restore without a version jump.

## The risk that decides the guardrails

The documented failure mode is **not RAM, it is disk**: a stalled logical replication slot
pins WAL and fills the filesystem. On this box that would also take down the trading bots
and their Postgres instances. Therefore, non-negotiable from day one:

1. A disk alarm at 80% that pages the owner.
2. A replication-slot lag check (`pg_replication_slots`) in the same probe.
3. `max_slot_wal_keep_size` bounded so Postgres drops a lagging slot rather than dying.
4. Per-container `mem_limit` so no container can starve nginx or the app.

## Data migration

Passwords are **bcrypt hashes independent of the JWT secret**, so they survive the move and
nobody resets anything. This is the single most important property of the plan, given users
cannot receive email.

Procedure (Supabase CLI, which wraps `pg_dump` with the right exclusions):

```sh
supabase db dump --db-url "$CLOUD_URL" -f roles.sql  --role-only
supabase db dump --db-url "$CLOUD_URL" -f schema.sql
supabase db dump --db-url "$CLOUD_URL" -f data.sql --use-copy --data-only -x storage.objects
```

Restore as `postgres`, in one transaction, with `session_replication_role = replica`.

Two documented traps, both verified rather than assumed at cutover:

- The CLI **comments out `CREATE PUBLICATION supabase_realtime`** (it already exists
  self-hosted) but keeps the `ALTER PUBLICATION … ADD TABLE` lines. Realtime silently does
  nothing if the publication ends up empty → verify `pg_publication_tables` lists
  `public.messages` and `public.call_signals`.
- The CLI's **data** dump deliberately includes the `auth` and `storage` schemas — that is
  how passwords travel. The self-hosted GoTrue image must therefore be **at least as new as
  cloud's**, booted once so it runs its own migrations, before auth data is loaded.

Files move over the **S3 protocol** (`rclone copy platform:attachments self-hosted:attachments`).
Copying into `volumes/storage/` by hand is explicitly documented not to work, because the
Storage API owns the on-disk layout and the `storage.objects` rows.

Attachment permissions still work afterwards: the `attachments_select` policy grants access
via `private.can_access_attachment(name, auth.uid())`, which derives from
`messages.attachment_path` plus room membership — not from the object's `owner`, which S3
upload rewrites.

## Self-sustaining operations

| Concern | Choice | Why this one |
| --- | --- | --- |
| Backups | nightly `pg_dump -Fc` + roles + storage tar + `.env`, 14-day rotation | one command restores; covers auth and storage schemas |
| Off-box copy | rclone → Backblaze B2 with a crypt remote | free under 10 GB, encrypted before it leaves the box |
| Backup alerting | healthchecks.io dead-man's switch | alerts when the backup *doesn't* run — the failure everyone misses |
| Uptime | 5-min local probe (`/auth/v1/health`, `/rest/v1/`, app) + an external HTTPS check | the external one still fires when the whole box is down |
| Firewall | ufw **plus** a `DOCKER-USER` backstop, ports bound to loopback | Docker bypasses ufw by writing its own iptables rules |
| SSH | key auth, root password retired | the current root password is compromised |
| Patching | unattended-upgrades, no auto-reboot | owner picks reboot windows |
| Upgrades | quarterly, pinned releases, backup first | image rollback does not roll back applied schema migrations |
| Runbook | `docs/RUNBOOK.md`, with a **measured** restore time | the RTO is a number you have tested, not a guess |

## Cutover

1. Build and boot the stack empty; let auth/storage/realtime run their migrations.
2. **Rehearse the full migration** onto it while cloud stays live. Fix every error found.
3. Maintenance window: stop the app, take final dumps.
4. Restore, copy storage, verify parity (auth users, identities, profiles, messages, objects).
5. Switch the app's env, redeploy, smoke test: username sign-in with an **unchanged**
   password, room list under RLS, realtime receipt in a second browser, attachment upload
   and open, an RPC through `private.assert_manager()`, and a call-signal round trip.
6. Keep the cloud project untouched for 14 days as the rollback. Data written self-hosted
   after cutover would be lost on rollback — that is the point of no return, and it is
   stated explicitly in the runbook.

## Rollback

Revert `NEXT_PUBLIC_SUPABASE_URL` and the two keys in the server's `.env.local`, redeploy.
The cloud project is still there and still has the data as of the cutover.

## Out of scope

Edge Functions, analytics/log retention, connection pooling (Supavisor), and read replicas.
Forty users on 2 vCPU do not need them, and each is a service that can fail at 3am.

## Success criteria

- The app runs against the self-hosted stack with **no code changes** beyond three env vars.
- Every existing user signs in with their existing password.
- A restore drill has been performed and its duration written down.
- Losing the VPS loses at most 24 hours of data, recoverable from an off-box encrypted copy.
- No new port is reachable from the internet.
