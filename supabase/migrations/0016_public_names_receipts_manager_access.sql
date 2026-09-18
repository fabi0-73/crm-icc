-- ============================================================
-- 0016_public_names_receipts_manager_access.sql
--
-- Ports three features from the parallel GitHub line (c22d37a) that were
-- never live, reviewed rather than copied:
--
--  1. Public display names — an optional chat-facing name for assistants
--     and agents. Internal/admin screens keep the real full name.
--  2. True delivery receipts — room_members.last_delivered_at, written when
--     a message actually reaches the recipient's device. Until now
--     "delivered" only meant "stored in a room that has someone else in it".
--  3. Manager access to agents/assignments removed at the DATABASE level.
--     Managers were already blocked from the Agents pages and actions; the
--     tables themselves were still readable to them directly. The spec asks
--     for both layers.
--
-- Deliberately NOT ported: GitHub's get_pinned_messages(). It is SECURITY
-- DEFINER and checks only membership, so it ignored each member's history
-- cutoff (can_view_history_from) and returned deleted messages that had
-- been pinned. The app now reads pins with an ordinary query, where the
-- messages_select policy enforces membership, the cutoff, the admin
-- override and deactivated accounts on its own; messages_pinned_idx
-- (0013) already serves it.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Public display names
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists public_name text;

create or replace function public.update_my_public_name(p_public_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text := private.current_user_role();
  v_name text := nullif(btrim(coalesce(p_public_name, '')), '');
begin
  if v_role is null then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  -- Admins and managers are always shown by their real name.
  if v_role not in ('assistant', 'agent') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'public name is too long';
  end if;
  update public.profiles
  set public_name = v_name
  where id = auth.uid();
end;
$$;

revoke execute on function public.update_my_public_name(text) from public, anon;
grant execute on function public.update_my_public_name(text) to authenticated;

-- ------------------------------------------------------------
-- 2. Delivery receipts
-- ------------------------------------------------------------
-- Existing rows are stamped with "now": everything already in the database
-- has, by definition, been delivered.
alter table public.room_members
  add column if not exists last_delivered_at timestamptz not null default now();

-- The client calls this on a trailing debounce per room, so a burst of
-- messages costs one write. There is intentionally no server-side skip:
-- skipping would drop the final call of a burst and leave its last message
-- stuck on "sent".
create or replace function public.mark_room_delivered(p_room_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members
  set last_delivered_at = now()
  where room_id = p_room_id
    and user_id = auth.uid()
    and private.current_user_role() is not null
$$;

revoke execute on function public.mark_room_delivered(uuid) from public, anon;
grant execute on function public.mark_room_delivered(uuid) to authenticated;

-- The sidebar's DM titles and "last message from" lines should use the
-- chat-facing name too. Same signature and return type as before — only
-- the two name expressions change — so every caller is unaffected.
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
  ) uc on true
  where rm.user_id = auth.uid()
    and private.current_user_role() is not null
  order by coalesce(lm.created_at, r.created_at) desc
$$;

-- ------------------------------------------------------------
-- 3. Managers lose direct access to agents / assignments
-- ------------------------------------------------------------
-- Checked before writing this: no other policy and no SECURITY INVOKER
-- function reads these tables, and every app code path that does is either
-- admin-only or uses the service role — so nothing managers rely on breaks.
-- The deactivated-account guard from the previous definitions is kept.
drop policy if exists agents_select on public.agents;
create policy agents_select on public.agents for select using (
  private.current_user_role() is not null
  and (
    private.current_user_role() = 'admin'
    or user_id = auth.uid()
    or exists (
      select 1 from public.assignments a
      where a.agent_id = agents.id
        and a.assistant_id = auth.uid()
        and a.removed_at is null
    )
  )
);

drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments for select using (
  private.current_user_role() is not null
  and (
    private.current_user_role() = 'admin'
    or assistant_id = auth.uid()
  )
);
