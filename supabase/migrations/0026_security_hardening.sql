-- ============================================================
-- 0026_security_hardening.sql — fixes from the 2026-10-08 security review.
--
-- 1. messages: a client could set ANY column on insert (the policy only
--    checked sender, kind and membership). Forged attachment_path let a
--    user read — and, via delete_message, delete — another room's file;
--    forged created_at backdated appointment posts (stealing "first post
--    wins" credit); pinned_at/edited_at/deleted_at and a cross-room
--    reply_to could be faked. Now only the columns the app sends are
--    insertable, a file must be the sender's own upload in that room's
--    folder, and a reply must point into the same room.
-- 2. delete_message removes a storage object only if the message's sender
--    owns it.
-- 3. appointments_export_range: managers could export any group's clients
--    without being a member; now membership is required (admins excepted).
-- 4. swap_assistants / create_agent_with_room: admin-only, as the app and
--    0016 intend (they were callable by managers straight through the API).
-- 5. add_room_member: managers can no longer add anyone (themselves
--    included) to an agent workspace.
-- 6. push_subscriptions.endpoint must be a real browser push service, so
--    the server's push sender can't be aimed at internal addresses.
-- 7. avatars bucket: images only (it is public and served from the CRM's
--    own origin, so an uploaded HTML/SVG file could run script there).
-- ============================================================

-- ---------- 1. messages insert ----------
create or replace function private.owns_upload(p_path text, p_room uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select split_part(p_path, '/', 1) = p_room::text
     and exists (
       select 1 from storage.objects o
       where o.bucket_id = 'attachments' and o.name = p_path and o.owner = auth.uid()
     )
$$;
alter function private.owns_upload(text, uuid) owner to postgres;
revoke all on function private.owns_upload(text, uuid) from public, anon;
grant execute on function private.owns_upload(text, uuid) to authenticated;

revoke insert on public.messages from anon, authenticated;
grant insert (room_id, sender_id, kind, body, attachment_path, attachment_name,
              attachment_size, attachment_mime, metadata, reply_to)
  on public.messages to authenticated;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  sender_id = auth.uid()
  and kind in ('text', 'file')
  and private.current_user_role() is not null
  and private.is_room_member(room_id, auth.uid())
  and (attachment_path is null or private.owns_upload(attachment_path, room_id))
  and (reply_to is null or exists (
        select 1 from public.messages r
        where r.id = reply_to and r.room_id = messages.room_id))
);

-- ---------- 2. delete_message ----------
create or replace function public.delete_message(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_msg messages%rowtype;
begin
  select * into v_msg from messages where id = p_id;
  if not found then raise exception 'message not found'; end if;
  if v_msg.kind = 'system' then raise exception 'system messages cannot be deleted'; end if;
  if not (
    v_msg.sender_id = v_actor
    or v_actor_role in ('admin', 'manager')
    or private.is_room_admin(v_msg.room_id, v_actor)
  ) then
    raise exception 'you cannot delete this message' using errcode = '42501';
  end if;

  -- Revoke the file itself; the message row keeps its attachment_* columns
  -- so the (kind='file') = (attachment_path is not null) check still holds,
  -- but the object is gone so no signed URL can resolve it.
  if v_msg.attachment_path is not null then
    delete from storage.objects
    where bucket_id = 'attachments' and name = v_msg.attachment_path
      and owner = v_msg.sender_id;
  end if;

  update messages set deleted_at = now(), body = '', metadata = null where id = p_id;
end;
$$;

-- ---------- 3. appointments export ----------
create or replace function public.appointments_export_range(
  p_room uuid,
  p_from date,
  p_to   date
)
returns table (
  shift_day     date,
  dialer_name   text,
  agent_name    text,
  policy_number text,
  client_name   text,
  phone         text,
  appt_date     date,
  appt_time     time,
  appt_tz       text,
  posted_by     text,
  created_at    timestamptz,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  select
    a.shift_day, a.dialer_name, a.agent_name, a.policy_number,
    a.client_name, a.phone, a.appt_date, a.appt_time, a.appt_tz,
    coalesce(p.full_name, '') as posted_by, a.created_at,
    p_from, p_to
  from public.appointments a
  join public.messages m on m.id = a.message_id and m.deleted_at is null
  left join public.profiles p on p.id = a.created_by
  where a.room_id = p_room
    and a.shift_day between p_from and p_to
    and private.current_user_role() is not null
    and (a.created_by = auth.uid() or private.drop_box_reviewer(auth.uid()))
    -- A reviewer sees the group's appointments only as a member of it
    -- (admins excepted), like its messages (messages_select, 0020).
    and (private.current_user_role() = 'admin'
         or private.is_room_member(p_room, auth.uid()))
  order by a.created_at
$$;

-- ---------- 4. agent workflows: admin only ----------
create or replace function private.assert_admin()
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
begin
  if private.current_user_role() is distinct from 'admin' then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
alter function private.assert_admin() owner to postgres;
revoke all on function private.assert_admin() from public, anon;
grant execute on function private.assert_admin() to authenticated;

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

-- ---------- 5. add_room_member ----------
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

  -- Groups and workspaces alike: only an app admin/manager or a room
  -- admin may add members.
  if not (v_actor_role in ('admin', 'manager')
          or private.is_room_admin(p_room_id, v_actor)) then
    raise exception 'only group admins can add members' using errcode = '42501';
  end if;
  -- Agent workspaces are admin business (0016): a manager may not add
  -- anyone — themselves included — unless already that room's admin.
  if v_room.type = 'agent_workspace' and v_actor_role is distinct from 'admin'
     and not private.is_room_admin(p_room_id, v_actor) then
    raise exception 'only admins manage agent workspaces' using errcode = '42501';
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
        last_read_at = now();

  select full_name into v_name from profiles where id = p_user_id;
  perform private.add_system_message(p_room_id, v_name || ' joined',
    jsonb_build_object('event', 'member_added', 'user_id', p_user_id));
  perform private.audit(v_actor, 'room_member.added', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id, 'history_from', p_history_from));
end;
$$;

-- ---------- 6. push endpoints ----------
alter table public.push_subscriptions drop constraint if exists push_endpoint_https;
alter table public.push_subscriptions add constraint push_endpoint_https check (
  endpoint ~ '^https://([a-z0-9-]+\.)*(push\.services\.mozilla\.com|fcm\.googleapis\.com|notify\.windows\.com|push\.apple\.com)(:443)?/'
) not valid;

-- ---------- 7. avatars bucket ----------
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
where id = 'avatars';
