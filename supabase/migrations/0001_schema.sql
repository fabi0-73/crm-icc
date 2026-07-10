-- ============================================================
-- 0001_schema.sql — tables, constraints, indexes
-- Internal CRM messaging system (agents / assistants / rooms)
-- ============================================================

-- Mirrors auth.users. Rows are created by the admin provisioning
-- flow (service role); public signup is disabled in the dashboard.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null,
  role        text not null check (role in ('admin', 'manager', 'assistant', 'agent')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- CRM record for an agent (the person being supported).
-- Agents log in, so every agent record links 1:1 to a profile.
create table public.agents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references public.profiles (id),
  display_name text not null,
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now()
);

-- Assistant <-> agent link. Never hard-deleted: closed with removed_*.
create table public.assignments (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references public.agents (id),
  assistant_id   uuid not null references public.profiles (id),
  assigned_at    timestamptz not null default now(),
  assigned_by    uuid not null references public.profiles (id),
  removed_at     timestamptz,
  removed_by     uuid references public.profiles (id),
  removal_reason text
);

-- One live assignment per (agent, assistant).
create unique index assignments_active_uniq
  on public.assignments (agent_id, assistant_id)
  where removed_at is null;
create index assignments_by_agent
  on public.assignments (agent_id)
  where removed_at is null;
create index assignments_by_assistant
  on public.assignments (assistant_id)
  where removed_at is null;

create table public.rooms (
  id         uuid primary key default gen_random_uuid(),
  type       text not null check (type in ('agent_workspace', 'group')),
  agent_id   uuid references public.agents (id),
  name       text not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  check ((type = 'agent_workspace') = (agent_id is not null))
);

-- One workspace room per agent.
create unique index rooms_one_workspace_per_agent
  on public.rooms (agent_id)
  where type = 'agent_workspace';

-- Membership rows are hard-deleted on removal (the change history
-- lives in audit_logs); re-adding a member is an upsert.
-- can_view_history_from: NULL = full history; otherwise the member
-- only sees messages created at/after this instant.
create table public.room_members (
  room_id               uuid not null references public.rooms (id),
  user_id               uuid not null references public.profiles (id),
  can_view_history_from timestamptz,
  last_read_at          timestamptz not null default now(),
  added_at              timestamptz not null default now(),
  added_by              uuid not null references public.profiles (id),
  primary key (room_id, user_id)
);

create index room_members_by_user on public.room_members (user_id);

-- Append-only in MVP: no edit/delete. sender_id is NULL for system
-- messages; metadata carries the structured system-message payload.
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms (id),
  sender_id       uuid references public.profiles (id),
  kind            text not null default 'text' check (kind in ('text', 'file', 'system')),
  body            text not null default '',
  attachment_path text,
  attachment_name text,
  attachment_size bigint,
  attachment_mime text,
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  check ((kind = 'system') = (sender_id is null)),
  check ((kind = 'file') = (attachment_path is not null))
);

create index messages_by_room on public.messages (room_id, created_at desc);
create index messages_by_attachment_path on public.messages (attachment_path)
  where attachment_path is not null;

-- Append-only audit trail. No client-facing write policies; only the
-- SECURITY DEFINER workflow functions (and the user-provisioning
-- server actions via service role) insert rows.
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (id),
  action      text not null,
  target_type text not null,
  target_id   uuid,
  room_id     uuid references public.rooms (id),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_logs_recent on public.audit_logs (created_at desc);
create index audit_logs_by_target on public.audit_logs (target_type, target_id);
