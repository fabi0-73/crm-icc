-- ============================================================
-- 0011 — message pinning, channel deletion, manager scope,
--         agent↔manager group membership, global search,
--         1000-character message limit.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Pinning
-- ------------------------------------------------------------
alter table public.messages
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references public.profiles (id);

create index if not exists messages_pinned_idx
  on public.messages (room_id, pinned_at desc)
  where pinned_at is not null;

-- Only app admins and managers may pin. Assistants, agents and any
-- other role are rejected even when they are a room admin.
create or replace function public.set_message_pinned(
  p_message_id uuid, p_pinned boolean
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role  text := private.current_user_role();
  v_room  uuid;
  v_type  text;
begin
  if v_actor is null or v_role not in ('admin', 'manager') then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select m.room_id, r.type into v_room, v_type
  from public.messages m
  join public.rooms r on r.id = m.room_id
  where m.id = p_message_id;
  if v_room is null then raise exception 'message not found'; end if;

  if v_type not in ('group', 'dm') then
    raise exception 'only group and direct messages can be pinned';
  end if;

  -- Managers must be in the conversation; admins may pin anywhere.
  if v_role <> 'admin' and not private.is_room_member(v_room, v_actor) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  update public.messages
  set pinned_at = case when p_pinned then now() else null end,
      pinned_by = case when p_pinned then v_actor else null end
  where id = p_message_id;

  perform private.audit(
    v_actor,
    case when p_pinned then 'message.pinned' else 'message.unpinned' end,
    'message', p_message_id, v_room, '{}'::jsonb
  );
end;
$$;

-- ------------------------------------------------------------
-- 2. Channel/group deletion
--    Admins: any group. Managers: groups they manage (room admin or
--    the creator). Workspaces and DMs are never deletable.
-- ------------------------------------------------------------
create or replace function public.delete_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role  text := private.current_user_role();
  v_room  rooms%rowtype;
begin
  if v_actor is null or v_role not in ('admin', 'manager') then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_room.type <> 'group' then
    raise exception 'only group channels can be deleted';
  end if;

  if v_role = 'manager'
     and not (private.is_room_admin(p_room_id, v_actor)
              or v_room.created_by = v_actor) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  perform private.audit(v_actor, 'room.deleted', 'room', p_room_id, null,
    jsonb_build_object('name', v_room.name, 'type', v_room.type));

  -- audit_logs.room_id references rooms, so the trail is detached
  -- rather than deleted (same rule as account deletion).
  update public.audit_logs set room_id = null where room_id = p_room_id;
  delete from public.call_signals where room_id = p_room_id;
  delete from public.messages where room_id = p_room_id;
  delete from public.room_members where room_id = p_room_id;
  delete from public.rooms where id = p_room_id;
end;
$$;

-- ------------------------------------------------------------
-- 3. Managers no longer reach the Agents section.
--    Agent records stay visible to admins, to the agent themselves
--    and to assigned assistants. Assistant assignment is admin-only.
-- ------------------------------------------------------------
drop policy if exists agents_select on public.agents;
create policy agents_select on public.agents for select using (
  private.current_user_role() = 'admin'
  or user_id = auth.uid()
  or exists (
    select 1 from public.assignments a
    where a.agent_id = agents.id
      and a.assistant_id = auth.uid()
      and a.removed_at is null
  )
);

drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments for select using (
  private.current_user_role() = 'admin'
  or assistant_id = auth.uid()
);

-- ------------------------------------------------------------
-- 4. Assigning a manager puts them in the agent's workspace group,
--    and clearing/replacing takes the previous manager out. The
--    room_members write is what drives the realtime roster update.
-- ------------------------------------------------------------
create or replace function public.set_agent_manager(
  p_agent_id uuid, p_manager_id uuid
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_admin();
  v_prev  uuid;
  v_room  uuid;
  v_name  text;
begin
  select manager_id into v_prev from public.agents where id = p_agent_id;
  if not found then raise exception 'agent not found'; end if;

  if p_manager_id is not null then
    if not exists (
      select 1 from profiles
      where id = p_manager_id and role = 'manager' and is_active
    ) then
      raise exception 'manager not found';
    end if;
  end if;

  update public.agents set manager_id = p_manager_id where id = p_agent_id;

  select id into v_room from public.rooms
  where agent_id = p_agent_id and type = 'agent_workspace';

  if v_room is not null then
    -- Previous manager leaves (unless they are the same person).
    if v_prev is not null and v_prev is distinct from p_manager_id then
      delete from public.room_members
      where room_id = v_room and user_id = v_prev;
      select coalesce(nullif(btrim(public_name), ''), full_name) into v_name
      from profiles where id = v_prev;
      if v_name is not null then
        perform private.add_system_message(v_room, v_name || ' left',
          jsonb_build_object('event', 'member_removed', 'user_id', v_prev));
      end if;
    end if;

    if p_manager_id is not null then
      insert into public.room_members
        (room_id, user_id, can_view_history_from, added_by, last_read_at, role)
      values (v_room, p_manager_id, null, v_actor, now(), 'admin')
      on conflict (room_id, user_id) do update
        set role = 'admin',
            can_view_history_from = null,
            added_by = excluded.added_by;

      select coalesce(nullif(btrim(public_name), ''), full_name) into v_name
      from profiles where id = p_manager_id;
      perform private.add_system_message(v_room, v_name || ' joined as manager',
        jsonb_build_object('event', 'member_added', 'user_id', p_manager_id));
    end if;
  end if;

  perform private.audit(v_actor, 'agent.manager_set', 'agent', p_agent_id, v_room,
    jsonb_build_object('manager_id', p_manager_id, 'previous_manager_id', v_prev));
end;
$$;

-- Assistant assignment follows the same rule: admins only. Body is
-- unchanged from 0003 apart from the permission gate.
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
  v_actor uuid := private.assert_admin();
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
-- 5. Global search — conversations, people and message history the
--    caller is allowed to see. Admins search everything.
-- ------------------------------------------------------------
create or replace function public.global_search(p_query text, p_limit int default 40)
returns table (
  kind text,
  room_id uuid,
  room_type text,
  message_id uuid,
  user_id uuid,
  title text,
  subtitle text,
  created_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid, private.current_user_role() as role
  ),
  q as (select '%' || btrim(p_query) || '%' as pattern),
  visible_rooms as (
    select r.*
    from public.rooms r, me
    where me.role is not null
      and (me.role = 'admin' or private.is_room_member(r.id, me.uid))
  )
  select
    'conversation' as kind,
    r.id as room_id,
    r.type as room_type,
    null::uuid as message_id,
    null::uuid as user_id,
    coalesce(
      case when r.type = 'dm' then (
        select coalesce(nullif(btrim(p2.public_name), ''), p2.full_name)
        from public.room_members rm2
        join public.profiles p2 on p2.id = rm2.user_id
        where rm2.room_id = r.id and rm2.user_id <> me.uid
        limit 1
      ) else r.name end,
      'Conversation'
    ) as title,
    case when r.type = 'dm' then 'Direct message' else 'Channel' end as subtitle,
    r.created_at
  from visible_rooms r, q, me
  where btrim(p_query) <> ''
    and coalesce(
          case when r.type = 'dm' then (
            select coalesce(nullif(btrim(p2.public_name), ''), p2.full_name)
            from public.room_members rm2
            join public.profiles p2 on p2.id = rm2.user_id
            where rm2.room_id = r.id and rm2.user_id <> me.uid
            limit 1
          ) else r.name end, '') ilike q.pattern

  union all

  select
    'person' as kind,
    null::uuid as room_id,
    null::text as room_type,
    null::uuid as message_id,
    p.id as user_id,
    coalesce(nullif(btrim(p.public_name), ''), p.full_name) as title,
    p.role as subtitle,
    p.created_at
  from public.profiles p, q, me
  where btrim(p_query) <> ''
    and p.is_active
    and p.id <> me.uid
    and (p.full_name ilike q.pattern or coalesce(p.public_name, '') ilike q.pattern)
    and (
      me.role = 'admin'
      or (me.role in ('manager', 'assistant') and p.role in ('admin', 'manager', 'assistant'))
      -- agents and assistants also find each other through a shared room
      or exists (
        select 1
        from public.room_members mine
        join public.room_members theirs on theirs.room_id = mine.room_id
        where mine.user_id = me.uid and theirs.user_id = p.id
      )
    )

  union all

  select
    'message' as kind,
    m.room_id,
    r.type as room_type,
    m.id as message_id,
    m.sender_id as user_id,
    coalesce(nullif(btrim(sp.public_name), ''), sp.full_name, 'System') as title,
    left(m.body, 160) as subtitle,
    m.created_at
  from public.messages m
  join visible_rooms r on r.id = m.room_id
  left join public.profiles sp on sp.id = m.sender_id
  cross join q
  where btrim(p_query) <> ''
    and m.kind <> 'system'
    and m.body ilike q.pattern

  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 40), 100))
$$;

-- Pinned messages for a room (respects the same visibility rules).
create or replace function public.get_pinned_messages(p_room_id uuid)
returns setof public.messages
language sql stable security definer
set search_path = public
as $$
  select m.*
  from public.messages m
  where m.room_id = p_room_id
    and m.pinned_at is not null
    and (
      private.current_user_role() = 'admin'
      or private.is_room_member(p_room_id, auth.uid())
    )
  order by m.pinned_at desc
$$;

-- ------------------------------------------------------------
-- 6. Message length cap. NOT VALID so existing long rows survive the
--    migration while every new insert is checked.
-- ------------------------------------------------------------
alter table public.messages drop constraint if exists messages_body_length_check;
alter table public.messages
  add constraint messages_body_length_check
  check (kind <> 'text' or char_length(body) <= 1000) not valid;

-- ------------------------------------------------------------
-- 7. Grants
-- ------------------------------------------------------------
grant execute on function
  public.set_message_pinned(uuid, boolean),
  public.delete_room(uuid),
  public.global_search(text, int),
  public.get_pinned_messages(uuid)
to authenticated;

revoke execute on function
  public.set_message_pinned(uuid, boolean),
  public.delete_room(uuid),
  public.global_search(text, int),
  public.get_pinned_messages(uuid)
from anon;
