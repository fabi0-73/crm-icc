-- ============================================================
-- 0009 — group add-member is admin-only; agents are admin-created;
--         public display name; delivery/read pointers.
-- ============================================================

-- Public chat name, separate from login/full_name/role.
alter table public.profiles
  add column if not exists public_name text;

alter table public.room_members
  add column if not exists last_delivered_at timestamptz not null default now();

update public.room_members
set last_delivered_at = last_read_at
where last_delivered_at < last_read_at;

-- ------------------------------------------------------------
-- Admin-only helper (managers keep swap_assistants via assert_manager).
-- ------------------------------------------------------------
create or replace function private.assert_admin()
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_role text := private.current_user_role();
begin
  if v_role is null or v_role <> 'admin' then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- Creating an agent account is admin-only. Managers may still view
-- agents and assign assistants via swap_assistants.
create or replace function public.create_agent_with_room(
  p_user_id uuid, p_display_name text
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_admin();
  v_agent uuid;
  v_room  uuid;
begin
  if not exists (
    select 1 from profiles where id = p_user_id and role = 'agent' and is_active
  ) then
    raise exception 'profile % is not an active agent account', p_user_id;
  end if;

  insert into agents (user_id, display_name, created_by)
  values (p_user_id, p_display_name, v_actor)
  returning id into v_agent;

  insert into rooms (type, agent_id, name, created_by)
  values ('agent_workspace', v_agent, p_display_name, v_actor)
  returning id into v_room;

  insert into room_members (room_id, user_id, can_view_history_from, added_by)
  values (v_room, p_user_id, null, v_actor);

  if v_actor is distinct from p_user_id then
    insert into room_members (room_id, user_id, can_view_history_from, added_by)
    values (v_room, v_actor, null, v_actor);
  end if;

  perform private.add_system_message(
    v_room, 'Workspace created',
    jsonb_build_object('event', 'workspace_created')
  );
  perform private.audit(v_actor, 'agent.created', 'agent', v_agent, v_room,
    jsonb_build_object('display_name', p_display_name, 'user_id', p_user_id));

  return v_agent;
end;
$$;

-- Groups: only room admins (or app admin/manager) may add members.
-- Assistants may add only when they are a room admin.
create or replace function public.add_room_member(
  p_room_id uuid, p_user_id uuid, p_history_from timestamptz default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
  v_role text;
  v_name text;
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;

  if v_room.type = 'dm' then
    raise exception 'direct message rooms have fixed membership';
  end if;

  if v_room.type = 'group' then
    if not (v_actor_role in ('admin', 'manager')
            or private.is_room_admin(p_room_id, v_actor)) then
      raise exception 'permission denied' using errcode = '42501';
    end if;
  else -- agent_workspace
    if v_actor_role not in ('admin', 'manager') then
      raise exception 'permission denied' using errcode = '42501';
    end if;
  end if;

  select role into v_role from profiles where id = p_user_id and is_active;
  if v_role is null then raise exception 'user % is not active', p_user_id; end if;

  if v_role = 'agent' then
    raise exception 'agent accounts only belong to their own workspace';
  end if;
  if v_room.type = 'agent_workspace' and v_role = 'assistant' then
    raise exception 'use swap_assistants to assign assistants to an agent workspace';
  end if;

  insert into room_members (room_id, user_id, can_view_history_from, added_by, last_read_at, role)
  values (p_room_id, p_user_id, p_history_from, v_actor, now(), 'member')
  on conflict (room_id, user_id) do update
    set can_view_history_from = excluded.can_view_history_from,
        added_by = excluded.added_by,
        added_at = now(),
        last_read_at = now(),
        last_delivered_at = now();

  select coalesce(nullif(btrim(public_name), ''), full_name) into v_name
  from profiles where id = p_user_id;
  perform private.add_system_message(p_room_id, v_name || ' joined',
    jsonb_build_object('event', 'member_added', 'user_id', p_user_id));
  perform private.audit(v_actor, 'room_member.added', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id, 'history_from', p_history_from));
end;
$$;

create or replace function public.mark_room_read(p_room_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members
  set last_read_at = now(),
      last_delivered_at = now()
  where room_id = p_room_id and user_id = auth.uid()
$$;

create or replace function public.mark_room_delivered(p_room_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members
  set last_delivered_at = now()
  where room_id = p_room_id and user_id = auth.uid()
$$;

-- Assistants and agents may set their public display name. Admins and
-- managers keep using full_name as the directory identity.
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

create or replace function public.get_my_rooms()
returns table (
  room_id uuid,
  name text,
  display_name text,
  type text,
  agent_id uuid,
  avatar_url text,
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

revoke execute on function
  private.assert_admin()
from public, anon, authenticated;

grant execute on function
  public.mark_room_delivered(uuid),
  public.update_my_public_name(text)
to authenticated;
