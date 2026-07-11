# ICC Messaging — Internal CRM

Assistants support agents in shared workspaces. Swap assistants without WhatsApp group churn; history access is controlled per membership.

## Stack

- Next.js 15 (App Router) + TypeScript
- Supabase (Postgres, Auth, Realtime, Storage)
- Vercel deploy target

## Setup

1. Create a Supabase project. Disable public signup (Auth → Providers → Email → disable sign-ups).

2. Apply migrations (SQL editor or CLI):

```bash
npx supabase db push
# or paste supabase/migrations/0001_schema.sql, 0002_rls_policies.sql, 0003_rpcs.sql in order
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
