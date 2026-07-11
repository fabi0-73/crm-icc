-- ============================================================
-- 0003_rpcs.sql — workflow functions
--
-- Every multi-table mutation is one SECURITY DEFINER function =
-- one transaction. Functions assert the caller's role themselves,
-- write their own audit rows, and post system messages, so partial
-- states are impossible. These are the ONLY writers for agents,
-- assignments, rooms, room_members, system messages and audit_logs
-- (besides the service-role user-provisioning server actions).
-- ============================================================

-- ------------------------------------------------------------
-- Private helpers
-- ------------------------------------------------------------

-- Raises unless the caller is an active admin/manager; returns actor id.
create or replace function private.assert_manager()
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_role text := private.current_user_role();
begin
  if v_role is null or v_role not in ('admin', 'manager') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function private.add_system_message(
  p_room uuid, p_body text, p_metadata jsonb default null
) returns uuid
language sql security definer
set search_path = public
as $$
  insert into public.messages (room_id, sender_id, kind, body, metadata)
  values (p_room, null, 'system', p_body, p_metadata)
  returning id
$$;

create or replace function private.audit(
  p_actor uuid, p_action text, p_target_type text,
  p_target_id uuid, p_room uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
language sql security definer
set search_path = public
as $$
  insert into public.audit_logs (actor_id, action, target_type, target_id, room_id, metadata)
  values (p_actor, p_action, p_target_type, p_target_id, p_room, p_metadata)
$$;

-- ------------------------------------------------------------
-- create_agent_with_room
-- The agent's auth account + profile (role 'agent') are created
-- beforehand by the server action (Auth Admin API). This function
-- does the transactional DB part.
-- ------------------------------------------------------------
create or replace function public.create_agent_with_room(
  p_user_id uuid, p_display_name text
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_manager();
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

  -- The agent user is a permanent member with full history.
  insert into room_members (room_id, user_id, can_view_history_from, added_by)
  values (v_room, p_user_id, null, v_actor);

  -- Creator (manager/admin) joins so they can open the workspace chat.
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

-- ------------------------------------------------------------
-- swap_assistants — THE core workflow.
-- p_additions: jsonb array [{"user_id": uuid, "history_from": timestamptz|null}]
--   history_from NULL = full history.
-- Empty remove list / empty additions make this the single
-- assign/unassign primitive as well.
-- The reason is stored ONLY in assignments/audit — never in chat.
-- ------------------------------------------------------------
create or replace function public.swap_assistants(
  p_agent_id uuid,
  p_remove_ids uuid[] default '{}',
  p_additions jsonb default '[]'::jsonb,
  p_reason text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_manager();
  v_room uuid;
  v_uid uuid;
  v_hist timestamptz;
  v_assignment uuid;
  v_name text;
  v_removed_names text[] := '{}';
  v_added_names text[] := '{}';
  v_add jsonb;
  v_parts text[] := '{}';
begin
  select r.id into v_room
  from rooms r
  where r.agent_id = p_agent_id and r.type = 'agent_workspace';
  if v_room is null then
    raise exception 'agent % has no workspace room', p_agent_id;
  end if;

  -- Removals: close the assignment, revoke room access immediately.
  foreach v_uid in array coalesce(p_remove_ids, '{}') loop
    update assignments
    set removed_at = now(), removed_by = v_actor, removal_reason = p_reason
    where agent_id = p_agent_id and assistant_id = v_uid and removed_at is null
    returning id into v_assignment;
    if v_assignment is null then
      raise exception 'no active assignment for user % on agent %', v_uid, p_agent_id;
    end if;

    delete from room_members where room_id = v_room and user_id = v_uid;

    select full_name into v_name from profiles where id = v_uid;
    v_removed_names := array_append(v_removed_names, v_name);

    perform private.audit(v_actor, 'assignment.removed', 'assignment', v_assignment, v_room,
      jsonb_build_object('agent_id', p_agent_id, 'assistant_id', v_uid, 'reason', p_reason));
    v_assignment := null;
  end loop;

  -- Additions: create the assignment, grant room access with the
  -- chosen history cutoff.
  for v_add in select * from jsonb_array_elements(coalesce(p_additions, '[]'::jsonb)) loop
    v_uid := (v_add ->> 'user_id')::uuid;
    v_hist := (v_add ->> 'history_from')::timestamptz;

    if not exists (
      select 1 from profiles where id = v_uid and role = 'assistant' and is_active
    ) then
      raise exception 'profile % is not an active assistant', v_uid;
    end if;
    if exists (
      select 1 from assignments
      where agent_id = p_agent_id and assistant_id = v_uid and removed_at is null
    ) then
      raise exception 'assistant % is already assigned to agent %', v_uid, p_agent_id;
    end if;

    insert into assignments (agent_id, assistant_id, assigned_by)
    values (p_agent_id, v_uid, v_actor)
    returning id into v_assignment;

    insert into room_members (room_id, user_id, can_view_history_from, added_by, last_read_at)
    values (v_room, v_uid, v_hist, v_actor, now())
    on conflict (room_id, user_id) do update
      set can_view_history_from = excluded.can_view_history_from,
          added_by = excluded.added_by,
          added_at = now(),
          last_read_at = now();

    select full_name into v_name from profiles where id = v_uid;
    v_added_names := array_append(v_added_names, v_name);

    perform private.audit(v_actor, 'assignment.added', 'assignment', v_assignment, v_room,
      jsonb_build_object('agent_id', p_agent_id, 'assistant_id', v_uid,
                         'history_from', v_hist, 'reason', p_reason));
  end loop;

  -- One neutral summary system message (facts only, no reason).
  if array_length(v_removed_names, 1) > 0 then
    v_parts := array_append(v_parts, array_to_string(v_removed_names, ', ') || ' left the workspace');
  end if;
  if array_length(v_added_names, 1) > 0 then
    v_parts := array_append(v_parts, array_to_string(v_added_names, ', ') || ' joined the workspace');
  end if;
  if array_length(v_parts, 1) > 0 then
    perform private.add_system_message(
      v_room, array_to_string(v_parts, ' · '),
      jsonb_build_object('event', 'swap', 'removed', v_removed_names, 'added', v_added_names)
    );
  end if;
end;
$$;

-- ------------------------------------------------------------
-- create_group_room — custom internal groups (staff only; agent
-- users are never members of group rooms).
-- p_member_ids: user ids to add alongside the creator.
-- ------------------------------------------------------------
create or replace function public.create_group_room(
  p_name text, p_member_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_manager();
  v_room uuid;
  v_uid uuid;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'group name is required';
  end if;

  insert into rooms (type, name, created_by)
  values ('group', trim(p_name), v_actor)
  returning id into v_room;

  insert into room_members (room_id, user_id, added_by)
  values (v_room, v_actor, v_actor);

  foreach v_uid in array coalesce(p_member_ids, '{}') loop
    if v_uid = v_actor then continue; end if;
    if not exists (
      select 1 from profiles
      where id = v_uid and is_active and role in ('admin', 'manager', 'assistant')
    ) then
      raise exception 'user % is not active staff (agents cannot join groups)', v_uid;
    end if;
    insert into room_members (room_id, user_id, added_by)
    values (v_room, v_uid, v_actor);
  end loop;

  perform private.add_system_message(v_room, 'Group created',
    jsonb_build_object('event', 'group_created'));
  perform private.audit(v_actor, 'room.created', 'room', v_room, v_room,
    jsonb_build_object('name', trim(p_name), 'member_ids', p_member_ids));

  return v_room;
end;
$$;

-- ------------------------------------------------------------
-- add_room_member / remove_room_member
-- For group rooms, and for adding staff (managers/admins) to
-- workspaces. Assistant membership in a workspace must go through
-- swap_assistants so assignments stay consistent.
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
-- mark_room_read — caller's own unread pointer.
-- ------------------------------------------------------------
create or replace function public.mark_room_read(p_room_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members
  set last_read_at = now()
  where room_id = p_room_id and user_id = auth.uid()
$$;

-- ------------------------------------------------------------
-- get_my_rooms — room list + last visible message + unread count,
-- one round trip, history cutoffs respected.
-- ------------------------------------------------------------
create or replace function public.get_my_rooms()
returns table (
  room_id uuid,
  name text,
  type text,
  agent_id uuid,
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
    r.type,
    r.agent_id,
    lm.created_at,
    left(lm.body, 140),
    lm.kind,
    lp.full_name,
    coalesce(uc.cnt, 0)
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
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
-- Grants: policies evaluate the private helpers as the querying
-- user, so authenticated (and anon, harmlessly) need EXECUTE.
-- Workflow RPCs are for authenticated users only; they enforce
-- roles internally.
-- ------------------------------------------------------------
grant usage on schema private to authenticated, anon;
grant execute on function
  private.current_user_role(),
  private.is_room_member(uuid, uuid),
  private.can_access_attachment(text, uuid)
to authenticated, anon;

revoke execute on function
  private.assert_manager(),
  private.add_system_message(uuid, text, jsonb),
  private.audit(uuid, text, text, uuid, uuid, jsonb)
from public, anon, authenticated;

revoke execute on function
  public.create_agent_with_room(uuid, text),
  public.swap_assistants(uuid, uuid[], jsonb, text),
  public.create_group_room(text, uuid[]),
  public.add_room_member(uuid, uuid, timestamptz),
  public.remove_room_member(uuid, uuid),
  public.mark_room_read(uuid),
  public.get_my_rooms()
from public, anon;

grant execute on function
  public.create_agent_with_room(uuid, text),
  public.swap_assistants(uuid, uuid[], jsonb, text),
  public.create_group_room(text, uuid[]),
  public.add_room_member(uuid, uuid, timestamptz),
  public.remove_room_member(uuid, uuid),
  public.mark_room_read(uuid),
  public.get_my_rooms()
to authenticated;
