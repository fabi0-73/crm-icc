-- ============================================================
-- 0019 — rooms where each member sees only their own messages
-- ============================================================
-- The ICC Appointments Group is not a conversation: 33 people file
-- appointments into it and nobody replies. Everyone could read everyone
-- else's. This makes it a drop box — a member sees what they posted, and
-- admins see all of it.
--
-- It is a per-room switch, not a hardcoded room, for one practical reason:
-- turning it back off is the rollback. No deploy, no code change, and no
-- message is ever deleted or altered.
--
-- Note what "everyone else's" leaks through. The SELECT policy is only the
-- first of four doors; the other three bypass RLS by design and are closed
-- further down:
--   * get_my_rooms  — security definer, feeds the sidebar preview + badge
--   * can_access_attachment — file permission is separate from message
--     permission
--   * the push sender — service role, patched in src/lib/push/sender.ts
-- Search needs nothing: it runs as the user against public.messages, so the
-- policy below already governs it (see 0014).

alter table public.rooms
  add column if not exists own_messages_only boolean not null default false;

comment on column public.rooms.own_messages_only is
  'Drop box: a member sees only messages they sent (plus system notices). Admins see all. Set false to revert instantly.';

-- ------------------------------------------------------------
-- The rule, in one place. Security definer so the policies below do not
-- drag public.rooms RLS into every row they check.
-- ------------------------------------------------------------
create or replace function private.room_own_messages_only(p_room uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select own_messages_only from public.rooms where id = p_room),
    false
  )
$$;

create or replace function private.is_admin(p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = p_user and role = 'admin' and is_active
  )
$$;

-- These are SECURITY DEFINER, so the owner IS the privilege they run with.
-- Match the other private.* helpers (current_user_role, is_room_member), which
-- are owned by postgres — not by whoever happens to apply this file.
alter function private.room_own_messages_only(uuid) owner to postgres;
alter function private.is_admin(uuid) owner to postgres;

-- ------------------------------------------------------------
-- messages: same as 0010, plus the drop-box clause.
--
-- System rows (sender_id is null — "X joined", call started/ended) stay
-- visible to everyone: they carry nobody's appointment, and hiding them
-- would also hide the call events ChatRoom watches.
-- ------------------------------------------------------------
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select using (
  private.current_user_role() is not null
  and (
    private.current_user_role() = 'admin'
    or exists (
      select 1 from public.room_members rm
      where rm.room_id = messages.room_id
        and rm.user_id = auth.uid()
        and (rm.can_view_history_from is null
             or messages.created_at >= rm.can_view_history_from)
        and (
          not private.room_own_messages_only(messages.room_id)
          or messages.sender_id = auth.uid()
          or messages.sender_id is null
        )
    )
  )
);

-- ------------------------------------------------------------
-- Door 2: the sidebar. get_my_rooms is security definer, so RLS does not
-- apply to it — without this every member would keep reading the newest
-- appointment in the room list and counting the rest in their badge.
-- Same shape as 0016; only the two lateral WHERE clauses change.
-- ------------------------------------------------------------
create or replace function public.get_my_rooms()
returns table (
  room_id uuid, name text, display_name text, type text, agent_id uuid,
  avatar_url text, dm_other_user_id uuid, last_message_at timestamptz,
  last_message_body text, last_message_kind text, last_message_sender text,
  unread_count bigint
)
language sql stable security definer
set search_path = public
as $$
  select
    r.id,
    r.name,
    case when r.type = 'dm'
         then coalesce(nullif(btrim(dm.public_name), ''), dm.full_name, 'Direct message')
         else r.name end,
    r.type,
    r.agent_id,
    r.avatar_url,
    dm.user_id,
    lm.created_at,
    left(lm.body, 140),
    lm.kind,
    coalesce(nullif(btrim(lp.public_name), ''), lp.full_name),
    coalesce(uc.cnt, 0)
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  left join lateral (
    select rm2.user_id, p2.full_name, p2.public_name
    from public.room_members rm2
    join public.profiles p2 on p2.id = rm2.user_id
    where r.type = 'dm'
      and rm2.room_id = r.id
      and rm2.user_id <> auth.uid()
    limit 1
  ) dm on true
  left join lateral (
    select m.created_at, m.body, m.kind, m.sender_id
    from public.messages m
    where m.room_id = r.id
      and (rm.can_view_history_from is null or m.created_at >= rm.can_view_history_from)
      -- Drop box: preview only what this reader is allowed to read.
      and (
        not r.own_messages_only
        or private.current_user_role() = 'admin'
        or m.sender_id = auth.uid()
        or m.sender_id is null
      )
    order by m.created_at desc
    limit 1
  ) lm on true
  left join public.profiles lp on lp.id = lm.sender_id
  left join lateral (
    select count(*) as cnt
    from public.messages m
    where m.room_id = r.id
      and m.created_at > rm.last_read_at
      and (rm.can_view_history_from is null or m.created_at >= rm.can_view_history_from)
      and m.sender_id is distinct from auth.uid()
      -- Drop box: a colleague's appointment is not unread mail for you.
      and (
        not r.own_messages_only
        or private.current_user_role() = 'admin'
        or m.sender_id is null
      )
  ) uc on true
  where rm.user_id = auth.uid()
    and private.current_user_role() is not null
  order by coalesce(lm.created_at, r.created_at) desc
$$;

-- ------------------------------------------------------------
-- Door 3: attachments. File permission is its own rule, so a member could
-- otherwise still fetch a colleague's attachment. Membership is still
-- required — this only relaxes for an admin INSIDE a drop-box room, so no
-- admin gains access anywhere they did not already have it.
-- ------------------------------------------------------------
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
      and (
        not private.room_own_messages_only(m.room_id)
        or m.sender_id = p_user
        or m.sender_id is null
        or private.is_admin(p_user)
      )
  )
$$;

-- ------------------------------------------------------------
-- Turn it on for the ICC Appointments Group.
-- ------------------------------------------------------------
update public.rooms
set own_messages_only = true
where id = '06b05e7b-682c-4104-8952-34dcec491f3b';
