-- ============================================================
-- 0010 — agent↔assistant DMs, admin visibility, call events,
--         agent managers, is_room_admin EXECUTE grant.
-- ============================================================

-- App admins/managers call private.is_room_admin from SECURITY
-- DEFINER RPCs. Revoking EXECUTE from authenticated made that call
-- fail with "permission denied for function is_room_admin".
create or replace function private.is_room_admin(p_room uuid, p_uid uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.room_members
    where room_id = p_room and user_id = p_uid and role = 'admin'
  );
end;
$$;

grant execute on function private.is_room_admin(uuid, uuid)
  to authenticated, anon;
grant execute on function private.ensure_group_has_admin(uuid)
  to authenticated, anon;

-- Manager assigned to oversee an agent (admin-managed).
alter table public.agents
  add column if not exists manager_id uuid references public.profiles (id);

-- ------------------------------------------------------------
-- Admins can read every conversation without joining.
-- Managers and everyone else keep membership-based access.
-- ------------------------------------------------------------
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select using (
  private.current_user_role() = 'admin'
  or exists (
    select 1 from public.room_members rm
    where rm.room_id = messages.room_id
      and rm.user_id = auth.uid()
      and (rm.can_view_history_from is null
           or messages.created_at >= rm.can_view_history_from)
  )
);

create or replace function private.can_access_attachment(p_path text, p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select
    private.current_user_role() = 'admin'
    or exists (
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
-- get_or_create_dm — staff↔staff as before, plus assigned
-- agent↔assistant private threads. Admins are not members.
-- ------------------------------------------------------------
create or replace function public.get_or_create_dm(p_other_user uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text := private.current_user_role();
  v_other_role text;
  v_key   text;
  v_room  uuid;
  v_staff boolean;
  v_pair  boolean;
begin
  if v_actor is null or v_actor_role is null then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_other_user is null or p_other_user = v_actor then
    raise exception 'cannot open a direct message with yourself';
  end if;

  select role into v_other_role from profiles where id = p_other_user and is_active;
  if v_other_role is null then
    raise exception 'user % is not active', p_other_user;
  end if;

  v_staff := v_actor_role in ('admin', 'manager', 'assistant')
         and v_other_role in ('admin', 'manager', 'assistant');
  v_pair := (v_actor_role = 'agent' and v_other_role = 'assistant')
         or (v_actor_role = 'assistant' and v_other_role = 'agent');

  if not v_staff and not v_pair then
    raise exception 'cannot open a direct message with that user';
  end if;

  if v_pair then
    if not exists (
      select 1
      from public.agents a
      join public.assignments s
        on s.agent_id = a.id and s.removed_at is null
      where (a.user_id = v_actor and s.assistant_id = p_other_user)
         or (a.user_id = p_other_user and s.assistant_id = v_actor)
    ) then
      raise exception 'agent and assistant are not assigned to each other';
    end if;
  end if;

  v_key := least(v_actor, p_other_user)::text || ':' || greatest(v_actor, p_other_user)::text;

  select id into v_room from rooms where type = 'dm' and dm_key = v_key;
  if v_room is not null then
    return v_room;
  end if;

  insert into rooms (type, name, dm_key, created_by)
  values ('dm', '', v_key, v_actor)
  on conflict (dm_key) where type = 'dm' do nothing
  returning id into v_room;

  if v_room is null then
    select id into v_room from rooms where type = 'dm' and dm_key = v_key;
    return v_room;
  end if;

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
-- Call start/end lines in the room history.
-- ------------------------------------------------------------
create or replace function public.post_call_event(
  p_room_id uuid, p_event text, p_body text
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or private.current_user_role() is null then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_event not in ('call_started', 'call_ended') then
    raise exception 'invalid call event';
  end if;
  if not private.is_room_member(p_room_id, v_uid)
     and private.current_user_role() <> 'admin' then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  perform private.add_system_message(
    p_room_id,
    p_body,
    jsonb_build_object('event', p_event)
  );
end;
$$;

-- ------------------------------------------------------------
-- Admin assigns (or clears) a manager on an agent.
-- ------------------------------------------------------------
create or replace function public.set_agent_manager(
  p_agent_id uuid, p_manager_id uuid
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_admin();
begin
  if p_manager_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_manager_id and role = 'manager' and is_active
    ) then
      raise exception 'manager not found';
    end if;
  end if;
  update public.agents
  set manager_id = p_manager_id
  where id = p_agent_id;
  if not found then raise exception 'agent not found'; end if;
  perform private.audit(v_actor, 'agent.manager_set', 'agent', p_agent_id, null,
    jsonb_build_object('manager_id', p_manager_id));
end;
$$;

-- ------------------------------------------------------------
-- get_my_rooms — members as before; admins also see every other
-- room (groups, DMs, workspaces) without joining.
-- ------------------------------------------------------------
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
  select * from (
    select
      r.id as room_id,
      r.name as name,
      case when r.type = 'dm'
           then coalesce(nullif(btrim(dm.public_name), ''), dm.full_name, 'Direct message')
           else r.name end as display_name,
      r.type as type,
      r.agent_id as agent_id,
      r.avatar_url as avatar_url,
      dm.user_id as dm_other_user_id,
      lm.created_at as last_message_at,
      left(lm.body, 140) as last_message_body,
      lm.kind as last_message_kind,
      coalesce(nullif(btrim(lp.public_name), ''), lp.full_name) as last_message_sender,
      coalesce(uc.cnt, 0) as unread_count
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

    union all

    select
      r.id as room_id,
      r.name as name,
      case when r.type = 'dm'
           then coalesce(nullif(btrim(dm.public_name), ''), dm.full_name, 'Direct message')
           else r.name end as display_name,
      r.type as type,
      r.agent_id as agent_id,
      r.avatar_url as avatar_url,
      dm.user_id as dm_other_user_id,
      lm.created_at as last_message_at,
      left(lm.body, 140) as last_message_body,
      lm.kind as last_message_kind,
      coalesce(nullif(btrim(lp.public_name), ''), lp.full_name) as last_message_sender,
      0::bigint as unread_count
    from public.rooms r
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
      order by m.created_at desc
      limit 1
    ) lm on true
    left join public.profiles lp on lp.id = lm.sender_id
    where private.current_user_role() = 'admin'
      and not exists (
        select 1 from public.room_members mine
        where mine.room_id = r.id and mine.user_id = auth.uid()
      )
  ) rooms
  order by last_message_at desc nulls last
$$;

grant execute on function
  public.post_call_event(uuid, text, text),
  public.set_agent_manager(uuid, uuid)
to authenticated;
