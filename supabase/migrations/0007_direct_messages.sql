-- ============================================================
-- 0007_direct_messages.sql — 1:1 staff DMs
--
-- A DM is a rooms row with type 'dm', name '' (display name is
-- computed from the other member's profile at read time) and a
-- normalized pair key so exactly one room exists per unordered
-- pair of users. Staff only (admin/manager/assistant); agent
-- accounts keep seeing exactly one room — their workspace.
-- No system messages in DMs; both members always see full history.
-- Membership is fixed for life: add/remove_room_member refuse DMs.
-- ============================================================

-- ------------------------------------------------------------
-- rooms: allow the new type + normalized pair key
-- ------------------------------------------------------------
alter table public.rooms drop constraint rooms_type_check;
alter table public.rooms add constraint rooms_type_check
  check (type in ('agent_workspace', 'group', 'dm'));

-- dm_key = least(user_a, user_b) || ':' || greatest(user_a, user_b),
-- set only on DM rooms. The partial unique index is the concurrency
-- guarantee: two racing get_or_create_dm calls can never create two
-- rooms for the same pair.
alter table public.rooms add column dm_key text;
alter table public.rooms add constraint rooms_dm_key_iff_dm
  check ((type = 'dm') = (dm_key is not null));

create unique index rooms_dm_key_uniq
  on public.rooms (dm_key)
  where type = 'dm';

-- ------------------------------------------------------------
-- Private helpers
-- ------------------------------------------------------------

-- Raises unless the caller is active staff (admin/manager/assistant);
-- returns actor id. Mirrors private.assert_manager().
create or replace function private.assert_staff()
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_role text := private.current_user_role();
begin
  if v_role is null or v_role not in ('admin', 'manager', 'assistant') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- ------------------------------------------------------------
-- get_or_create_dm — idempotent get-or-create for the caller's DM
-- with another active staff member. Returns the room id.
-- Race-safe via ON CONFLICT on the dm_key partial unique index.
-- No system message ("X joined" is noise in a 1:1); audit row only
-- on actual creation.
-- ------------------------------------------------------------
create or replace function public.get_or_create_dm(p_other_user uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_key   text;
  v_room  uuid;
begin
  if p_other_user is null or p_other_user = v_actor then
    raise exception 'cannot open a direct message with yourself';
  end if;

  if not exists (
    select 1 from profiles
    where id = p_other_user
      and is_active
      and role in ('admin', 'manager', 'assistant')
  ) then
    raise exception 'user % is not active staff (agents cannot receive DMs)', p_other_user;
  end if;

  v_key := least(v_actor, p_other_user)::text || ':' || greatest(v_actor, p_other_user)::text;

  -- Fast path: the pair already has a room.
  select id into v_room from rooms where type = 'dm' and dm_key = v_key;
  if v_room is not null then
    return v_room;
  end if;

  -- Create; on a concurrent create we lose the conflict and re-read.
  insert into rooms (type, name, dm_key, created_by)
  values ('dm', '', v_key, v_actor)
  on conflict (dm_key) where type = 'dm' do nothing
  returning id into v_room;

  if v_room is null then
    select id into v_room from rooms where type = 'dm' and dm_key = v_key;
    return v_room;
  end if;

  -- Both members permanent, full history (no cutoff use case in a 1:1).
  insert into room_members (room_id, user_id, can_view_history_from, added_by)
  values
    (v_room, v_actor, null, v_actor),
    (v_room, p_other_user, null, v_actor);

  perform private.audit(v_actor, 'dm.created', 'room', v_room, v_room,
    jsonb_build_object('member_ids', array[v_actor, p_other_user]));

  return v_room;
end;
$$;

-- ------------------------------------------------------------
-- add_room_member / remove_room_member — DM membership is fixed.
-- (CREATE OR REPLACE keeps existing grants.)
-- ------------------------------------------------------------
create or replace function public.add_room_member(
  p_room_id uuid, p_user_id uuid, p_history_from timestamptz default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_manager();
  v_room rooms%rowtype;
  v_role text;
  v_name text;
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;

  if v_room.type = 'dm' then
    raise exception 'direct message rooms have fixed membership';
  end if;

  select role into v_role from profiles where id = p_user_id and is_active;
  if v_role is null then raise exception 'user % is not active', p_user_id; end if;

  if v_role = 'agent' then
    raise exception 'agent accounts only belong to their own workspace';
  end if;
  if v_room.type = 'agent_workspace' and v_role = 'assistant' then
    raise exception 'use swap_assistants to assign assistants to an agent workspace';
  end if;

  insert into room_members (room_id, user_id, can_view_history_from, added_by, last_read_at)
  values (p_room_id, p_user_id, p_history_from, v_actor, now())
  on conflict (room_id, user_id) do update
    set can_view_history_from = excluded.can_view_history_from,
        added_by = excluded.added_by,
        added_at = now(),
        last_read_at = now();

  select full_name into v_name from profiles where id = p_user_id;
  perform private.add_system_message(p_room_id, v_name || ' joined',
    jsonb_build_object('event', 'member_added', 'user_id', p_user_id));
  perform private.audit(v_actor, 'room_member.added', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id, 'history_from', p_history_from));
end;
$$;

create or replace function public.remove_room_member(
  p_room_id uuid, p_user_id uuid
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_manager();
  v_room rooms%rowtype;
  v_name text;
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;

  if v_room.type = 'dm' then
    raise exception 'direct message rooms have fixed membership';
  end if;

  if v_room.type = 'agent_workspace' then
    if exists (select 1 from agents a where a.id = v_room.agent_id and a.user_id = p_user_id) then
      raise exception 'the agent cannot be removed from their own workspace';
    end if;
    if exists (
      select 1 from assignments
      where agent_id = v_room.agent_id and assistant_id = p_user_id and removed_at is null
    ) then
      raise exception 'use swap_assistants to remove assigned assistants';
    end if;
  end if;

  delete from room_members where room_id = p_room_id and user_id = p_user_id;
  if not found then raise exception 'user is not a member of this room'; end if;

  select full_name into v_name from profiles where id = p_user_id;
  perform private.add_system_message(p_room_id, v_name || ' left',
    jsonb_build_object('event', 'member_removed', 'user_id', p_user_id));
  perform private.audit(v_actor, 'room_member.removed', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id));
end;
$$;

-- ------------------------------------------------------------
-- get_my_rooms — adds display_name (other member's name for DMs,
-- rooms.name otherwise) and dm_other_user_id (for presence).
-- Changing the OUT-column list of a RETURNS TABLE function requires
-- DROP FUNCTION first (CREATE OR REPLACE cannot change return type),
-- which also drops grants — re-issued below.
-- ------------------------------------------------------------
drop function public.get_my_rooms();

create function public.get_my_rooms()
returns table (
  room_id uuid,
  name text,
  display_name text,
  type text,
  agent_id uuid,
  dm_other_user_id uuid,
  last_message_at timestamptz,
  last_message_body text,
  last_message_kind text,
  last_message_sender text,
  unread_count bigint
)
language sql stable security definer
set search_path = public
as $$
  select
    r.id,
    r.name,
    case when r.type = 'dm'
         then coalesce(dm.full_name, 'Direct message')
         else r.name end,
    r.type,
    r.agent_id,
    dm.user_id,
    lm.created_at,
    left(lm.body, 140),
    lm.kind,
    lp.full_name,
    coalesce(uc.cnt, 0)
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  left join lateral (
    select rm2.user_id, p2.full_name
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
-- Grants
-- ------------------------------------------------------------
revoke execute on function
  private.assert_staff()
from public, anon, authenticated;

revoke execute on function
  public.get_or_create_dm(uuid),
  public.get_my_rooms()
from public, anon;

grant execute on function
  public.get_or_create_dm(uuid),
  public.get_my_rooms()
to authenticated;
