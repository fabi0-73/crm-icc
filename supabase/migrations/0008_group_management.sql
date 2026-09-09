-- ============================================================
-- 0008_group_management.sql
-- Group chats grow up: per-member roles (admin/member), a member
-- lifecycle any group member drives (add / leave) with removals and
-- renames reserved for group admins, an optional group avatar, and
-- realtime on the roster so membership changes land without a refresh.
--
-- Design notes:
--  * Authorization is per-room, layered ON TOP of the existing app
--    roles. An app admin/manager can still manage any group; inside a
--    group, its own admins can too. Assistants gain power only in the
--    groups they belong to.
--  * agent_workspace and dm rooms are untouched in behaviour: workspaces
--    stay manager-only and route assistants through swap_assistants; dms
--    keep fixed membership. Only 'group' rooms get the new lifecycle.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Per-membership role
-- ------------------------------------------------------------
alter table public.room_members
  add column if not exists role text not null default 'member'
  check (role in ('admin', 'member'));

-- Whoever created a room is its first admin. (created_by is reassigned
-- when a user is deleted, but only among still-present rooms, so this
-- backfill is correct for every room that still has its creator.)
update public.room_members rm
set role = 'admin'
from public.rooms r
where r.id = rm.room_id
  and r.created_by = rm.user_id
  and rm.role <> 'admin';

-- A group with members must always have at least one admin; if the
-- backfill left one without (creator long gone), promote the earliest
-- joiner so the group is never leaderless.
update public.room_members rm
set role = 'admin'
where rm.room_id in (
  select r.id from public.rooms r
  where r.type = 'group'
    and exists (select 1 from public.room_members m where m.room_id = r.id)
    and not exists (
      select 1 from public.room_members m where m.room_id = r.id and m.role = 'admin'
    )
)
and rm.user_id = (
  select m.user_id from public.room_members m
  where m.room_id = rm.room_id order by m.added_at asc limit 1
);

-- ------------------------------------------------------------
-- 2. Optional group avatar
-- ------------------------------------------------------------
alter table public.rooms add column if not exists avatar_url text;

-- ------------------------------------------------------------
-- 3. Avatars storage bucket (public-read, staff-write, 2 MB)
--    Public bucket => images are served without a signed URL, which is
--    what the sidebar and headers need. Writes are still gated.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 2097152)
on conflict (id) do nothing;

drop policy if exists avatars_insert on storage.objects;
drop policy if exists avatars_update on storage.objects;
create policy avatars_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and private.current_user_role() in ('admin', 'manager', 'assistant')
  );
create policy avatars_update on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and private.current_user_role() in ('admin', 'manager', 'assistant')
  );

-- ------------------------------------------------------------
-- 4. Room-admin helper + "never leaderless" helper
-- ------------------------------------------------------------
create or replace function private.is_room_admin(p_room uuid, p_uid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room and user_id = p_uid and role = 'admin'
  )
$$;

create or replace function private.ensure_group_has_admin(p_room uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members
  set role = 'admin'
  where room_id = p_room
    and user_id = (
      select user_id from public.room_members
      where room_id = p_room order by added_at asc limit 1
    )
    and exists (select 1 from public.room_members where room_id = p_room)
    and not exists (
      select 1 from public.room_members where room_id = p_room and role = 'admin'
    )
$$;

-- ------------------------------------------------------------
-- 5. create_group_room — now takes an optional avatar and makes the
--    creator a room admin. Old 2-arg signature dropped so callers can't
--    bind the stale one.
-- ------------------------------------------------------------
drop function if exists public.create_group_room(text, uuid[]);

create function public.create_group_room(
  p_name text, p_member_ids uuid[] default '{}', p_avatar_url text default null
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

  insert into rooms (type, name, created_by, avatar_url)
  values ('group', trim(p_name), v_actor, nullif(trim(coalesce(p_avatar_url, '')), ''))
  returning id into v_room;

  insert into room_members (room_id, user_id, added_by, role)
  values (v_room, v_actor, v_actor, 'admin');

  foreach v_uid in array coalesce(p_member_ids, '{}') loop
    if v_uid = v_actor then continue; end if;
    if not exists (
      select 1 from profiles
      where id = v_uid and is_active and role in ('admin', 'manager', 'assistant')
    ) then
      raise exception 'user % is not active staff (agents cannot join groups)', v_uid;
    end if;
    insert into room_members (room_id, user_id, added_by, role)
    values (v_room, v_uid, v_actor, 'member')
    on conflict (room_id, user_id) do nothing;
  end loop;

  perform private.add_system_message(v_room, 'Group created',
    jsonb_build_object('event', 'group_created'));
  perform private.audit(v_actor, 'room.created', 'room', v_room, v_room,
    jsonb_build_object('name', trim(p_name), 'member_ids', p_member_ids));

  return v_room;
end;
$$;

-- ------------------------------------------------------------
-- 6. add_room_member — any group member (or app admin/manager) may add
--    staff to a group; workspaces stay manager-only.
-- ------------------------------------------------------------
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
            or private.is_room_member(p_room_id, v_actor)) then
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
        last_read_at = now();

  select full_name into v_name from profiles where id = p_user_id;
  perform private.add_system_message(p_room_id, v_name || ' joined',
    jsonb_build_object('event', 'member_added', 'user_id', p_user_id));
  perform private.audit(v_actor, 'room_member.added', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id, 'history_from', p_history_from));
end;
$$;

-- ------------------------------------------------------------
-- 7. remove_room_member — group admins (or app admin/manager) may remove
--    others; workspaces keep the manager-only + swap_assistants guards.
-- ------------------------------------------------------------
create or replace function public.remove_room_member(
  p_room_id uuid, p_user_id uuid
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
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
      raise exception 'only group admins can remove members' using errcode = '42501';
    end if;
  else -- agent_workspace
    if v_actor_role not in ('admin', 'manager') then
      raise exception 'permission denied' using errcode = '42501';
    end if;
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
  perform private.add_system_message(p_room_id, coalesce(v_name, 'A member') || ' was removed',
    jsonb_build_object('event', 'member_removed', 'user_id', p_user_id));
  perform private.audit(v_actor, 'room_member.removed', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id));

  perform private.ensure_group_has_admin(p_room_id);
end;
$$;

-- ------------------------------------------------------------
-- 8. leave_room — a member removes themselves from a group.
-- ------------------------------------------------------------
create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_room rooms%rowtype;
  v_name text;
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_room.type <> 'group' then
    raise exception 'you can only leave group chats';
  end if;

  delete from room_members where room_id = p_room_id and user_id = v_actor;
  if not found then raise exception 'you are not a member of this room'; end if;

  select full_name into v_name from profiles where id = v_actor;
  perform private.add_system_message(p_room_id, coalesce(v_name, 'A member') || ' left',
    jsonb_build_object('event', 'member_left', 'user_id', v_actor));
  perform private.audit(v_actor, 'room_member.left', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', v_actor));

  perform private.ensure_group_has_admin(p_room_id);
end;
$$;

-- ------------------------------------------------------------
-- 9. set_room_member_role — promote/demote inside a group.
-- ------------------------------------------------------------
create or replace function public.set_room_member_role(
  p_room_id uuid, p_user_id uuid, p_role text
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
begin
  if p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member';
  end if;

  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_room.type <> 'group' then
    raise exception 'roles apply to group chats only';
  end if;

  if not (v_actor_role in ('admin', 'manager')
          or private.is_room_admin(p_room_id, v_actor)) then
    raise exception 'only group admins can change roles' using errcode = '42501';
  end if;

  update room_members set role = p_role
  where room_id = p_room_id and user_id = p_user_id;
  if not found then raise exception 'user is not a member of this room'; end if;

  perform private.audit(v_actor, 'room_member.role', 'room', p_room_id, p_room_id,
    jsonb_build_object('user_id', p_user_id, 'role', p_role));

  -- Demoting the last admin would leave the group leaderless; put one back.
  perform private.ensure_group_has_admin(p_room_id);
end;
$$;

-- ------------------------------------------------------------
-- 10. rename_room / set_room_avatar — group admins only.
-- ------------------------------------------------------------
create or replace function public.rename_room(p_room_id uuid, p_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'group name is required';
  end if;

  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_room.type <> 'group' then
    raise exception 'only group chats can be renamed';
  end if;
  if not (v_actor_role in ('admin', 'manager')
          or private.is_room_admin(p_room_id, v_actor)) then
    raise exception 'only group admins can rename the group' using errcode = '42501';
  end if;

  update rooms set name = trim(p_name) where id = p_room_id;

  perform private.add_system_message(p_room_id, 'Group renamed to "' || trim(p_name) || '"',
    jsonb_build_object('event', 'room_renamed'));
  perform private.audit(v_actor, 'room.renamed', 'room', p_room_id, p_room_id,
    jsonb_build_object('name', trim(p_name)));
end;
$$;

create or replace function public.set_room_avatar(p_room_id uuid, p_avatar_url text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then raise exception 'room not found'; end if;
  if v_room.type <> 'group' then
    raise exception 'only group chats have an avatar';
  end if;
  if not (v_actor_role in ('admin', 'manager')
          or private.is_room_admin(p_room_id, v_actor)) then
    raise exception 'only group admins can change the group image' using errcode = '42501';
  end if;

  update rooms set avatar_url = nullif(trim(coalesce(p_avatar_url, '')), '')
  where id = p_room_id;

  perform private.audit(v_actor, 'room.avatar', 'room', p_room_id, p_room_id, '{}'::jsonb);
end;
$$;

-- ------------------------------------------------------------
-- 11. get_my_rooms — carry the group avatar so lists can show it.
--    Return shape changes, so drop + recreate.
-- ------------------------------------------------------------
drop function if exists public.get_my_rooms();

create function public.get_my_rooms()
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
         then coalesce(dm.full_name, 'Direct message')
         else r.name end,
    r.type,
    r.agent_id,
    r.avatar_url,
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
-- 12. Realtime on the roster. FULL replica identity so the DELETE old-row
--     reaches subscribers' RLS checks (Supabase needs the whole old row
--     to decide who may see a removal).
-- ------------------------------------------------------------
alter table public.room_members replica identity full;
alter publication supabase_realtime add table public.room_members;

-- ------------------------------------------------------------
-- 13. Grants
-- ------------------------------------------------------------
revoke execute on function
  private.is_room_admin(uuid, uuid),
  private.ensure_group_has_admin(uuid)
from public, anon, authenticated;

revoke execute on function
  public.create_group_room(text, uuid[], text),
  public.leave_room(uuid),
  public.set_room_member_role(uuid, uuid, text),
  public.rename_room(uuid, text),
  public.set_room_avatar(uuid, text)
from public, anon;

grant execute on function
  public.create_group_room(text, uuid[], text),
  public.leave_room(uuid),
  public.set_room_member_role(uuid, uuid, text),
  public.rename_room(uuid, text),
  public.set_room_avatar(uuid, text)
to authenticated;
