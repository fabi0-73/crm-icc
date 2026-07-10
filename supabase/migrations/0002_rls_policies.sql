-- ============================================================
-- 0002_rls_policies.sql — row level security
--
-- Principles:
--   * RLS enforces ALL reads and the one hot-path write
--     (sending a message).
--   * No client-facing write policies anywhere else — every other
--     mutation goes through the SECURITY DEFINER workflow functions
--     in 0003_rpcs.sql (which bypass RLS as the function owner).
--   * The messages SELECT policy IS the history-visibility feature.
-- ============================================================

-- ------------------------------------------------------------
-- Private helpers (SECURITY DEFINER so policy checks never recurse
-- into the tables they protect).
-- ------------------------------------------------------------
create schema if not exists private;

-- Role of the calling user, or NULL if missing/deactivated.
-- Reads profiles directly (owner bypasses RLS), so a stale JWT can
-- never resurrect a deactivated user.
create or replace function private.current_user_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles
  where id = auth.uid() and is_active
$$;

create or replace function private.is_room_member(p_room uuid, p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room and user_id = p_user
  )
$$;

-- Attachment visibility mirrors message visibility, including the
-- per-member history cutoff — old files never leak to new members.
create or replace function private.can_access_attachment(p_path text, p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.messages m
    join public.room_members rm
      on rm.room_id = m.room_id and rm.user_id = p_user
    where m.attachment_path = p_path
      and (rm.can_view_history_from is null
           or m.created_at >= rm.can_view_history_from)
  )
$$;

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------
alter table public.profiles enable row level security;

-- Staff (admin/manager/assistant) can read the whole directory.
-- Agent users only see themselves and people who share a room with
-- them (their assistants and managers).
create policy profiles_select on public.profiles for select using (
  id = auth.uid()
  or private.current_user_role() in ('admin', 'manager', 'assistant')
  or (
    private.current_user_role() = 'agent'
    and exists (
      select 1
      from public.room_members mine
      join public.room_members theirs on theirs.room_id = mine.room_id
      where mine.user_id = auth.uid()
        and theirs.user_id = profiles.id
    )
  )
);

-- ------------------------------------------------------------
-- agents
-- ------------------------------------------------------------
alter table public.agents enable row level security;

create policy agents_select on public.agents for select using (
  private.current_user_role() in ('admin', 'manager')
  or user_id = auth.uid()
  or exists (
    select 1 from public.assignments a
    where a.agent_id = agents.id
      and a.assistant_id = auth.uid()
      and a.removed_at is null
  )
);

-- ------------------------------------------------------------
-- assignments
-- ------------------------------------------------------------
alter table public.assignments enable row level security;

create policy assignments_select on public.assignments for select using (
  private.current_user_role() in ('admin', 'manager')
  or assistant_id = auth.uid()
);

-- ------------------------------------------------------------
-- rooms
-- ------------------------------------------------------------
alter table public.rooms enable row level security;

create policy rooms_select on public.rooms for select using (
  private.is_room_member(id, auth.uid())
  or private.current_user_role() in ('admin', 'manager')
);

-- ------------------------------------------------------------
-- room_members
-- ------------------------------------------------------------
alter table public.room_members enable row level security;

create policy room_members_select on public.room_members for select using (
  private.is_room_member(room_id, auth.uid())
  or private.current_user_role() in ('admin', 'manager')
);

-- ------------------------------------------------------------
-- messages — the core policy of the whole system
-- ------------------------------------------------------------
alter table public.messages enable row level security;

-- A member sees a message iff their membership's history cutoff
-- allows it. Realtime subscriptions are filtered by this same
-- policy, per subscriber.
create policy messages_select on public.messages for select using (
  exists (
    select 1 from public.room_members rm
    where rm.room_id = messages.room_id
      and rm.user_id = auth.uid()
      and (rm.can_view_history_from is null
           or messages.created_at >= rm.can_view_history_from)
  )
);

-- Hot path: active members insert text/file messages directly.
-- System messages can only come from the workflow functions.
create policy messages_insert on public.messages for insert with check (
  sender_id = auth.uid()
  and kind in ('text', 'file')
  and private.current_user_role() is not null
  and private.is_room_member(room_id, auth.uid())
);

-- ------------------------------------------------------------
-- audit_logs — readable by admin/manager, writable by no client
-- ------------------------------------------------------------
alter table public.audit_logs enable row level security;

create policy audit_logs_select on public.audit_logs for select using (
  private.current_user_role() in ('admin', 'manager')
);

-- ------------------------------------------------------------
-- Storage: private "attachments" bucket
-- Path convention: {room_id}/{uuid}/{filename}
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400) -- 25 MB
on conflict (id) do nothing;

create policy attachments_insert on storage.objects for insert with check (
  bucket_id = 'attachments'
  and private.current_user_role() is not null
  and private.is_room_member(((storage.foldername(name))[1])::uuid, auth.uid())
);

create policy attachments_select on storage.objects for select using (
  bucket_id = 'attachments'
  and (
    owner = auth.uid()
    or private.can_access_attachment(name, auth.uid())
  )
);

-- ------------------------------------------------------------
-- Realtime: broadcast message inserts (RLS-filtered per subscriber)
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
