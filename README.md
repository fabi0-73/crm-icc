# ICC Messaging — Internal CRM

Assistants support agents in shared workspaces. Swap assistants without WhatsApp group churn; history access is controlled per membership.

## Stack

- Next.js 15 (App Router) + TypeScript
- Self-hosted Supabase on the same VPS (Postgres, Auth, Realtime,
  Storage) — see `ops/supabase/` and `docs/RUNBOOK.md`
- Deployed on a VPS: systemd service `crm-icc` (`next start -p 3010`)
  behind nginx at https://chat.icenterconsult.com
  (the older https://iccdesk.duckdns.org still resolves to the same app)
- coturn on the same VPS relays WebRTC calls (`NEXT_PUBLIC_TURN_*` env;
  no credentials in code — without env the client is STUN-only)

## Deploying

From a clone with SSH access to the VPS (Git Bash on Windows):

```bash
ICC_SSH_KEY=~/.ssh/icc_vps_ed25519 scripts/deploy.sh
# or ICC_SSH_PASS='...' scripts/deploy.sh
```

The script ships `git HEAD` (uncommitted changes are not deployed),
builds on the server, restarts the service, and health-checks it.
The server's `.env.local` is never touched.

Design note: role checks read `profiles` via the SECURITY DEFINER
helper `private.current_user_role()` instead of a JWT custom access
token hook — no dashboard hook config to forget, and deactivation
takes effect on the next query instead of at token refresh
(migration 0006 extends this to all SELECT policies).

## Setup

1. Create a Supabase project. Disable public signup (Auth → Providers → Email → disable sign-ups).

2. Apply migrations (SQL editor or CLI):

```bash
npx supabase db push
# or paste supabase/migrations/0001…0006 in the SQL editor, in order
```

3. Copy env:

```bash
cp .env.example .env.local
```

Fill `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`.

4. Bootstrap the first admin: create a user in Supabase Auth, then run `supabase/bootstrap_admin.sql` with their UUID.

5. Run the app:

```bash
npm install
npm run dev
```

6. Auth redirect URLs in Supabase: add `http://localhost:3000/auth/callback` and `http://localhost:3000/auth/reset-password`.

## Roles

| Role | Can |
|------|-----|
| Admin | Users, agents, swaps, groups, audit |
| Manager | Agents, swaps, groups, audit |
| Assistant | Assigned workspaces + groups they're in |
| Agent | Own workspace only |

## Core flow

1. Admin invites staff (Users).
2. Manager/admin creates an agent → account + workspace room.
3. Swap assistants on agent detail (history preset + audit reason).
4. Chat in real time; attachments respect the same history cutoff.

## Pilot / WhatsApp cutover

1. Pilot 1–2 agents: create accounts, rooms, assignments.
2. Post app link + hard cutover date in the WhatsApp group.
3. Cutover day: freeze WhatsApp to admin-only; all replies in the app; post a manual context summary as the first message.
4. After two quiet weeks, archive the WhatsApp group; roll remaining agents in batches.

No automated WhatsApp import.

## Verification

- `supabase/tests/rls_suite.sql` — RLS checks (needs fixture users).
- Manual: two browsers live-chat; swap assistant A→B with “last 30 days”; confirm A loses the room and B sees the cutoff window.
- Mobile: login → badges → reply → attach photo on a phone browser.

## v2 (not in MVP)

Push/PWA, search, edit/delete, read receipts, notes, DMs, mentions, tasks, typing, pinning, AI summaries, dashboards, 2FA.
