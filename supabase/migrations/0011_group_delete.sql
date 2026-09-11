-- ============================================================
-- 0011_group_delete.sql — group deletion + assistant-created groups
--
--  * create_group_room is opened from admin/manager to any staff
--    (admin/manager/assistant) so assistants can own groups too. The
--    creator is still seeded as the group's room admin.
--  * delete_room removes a group entirely in one transaction. An app
--    ADMIN may delete ANY group; a MANAGER or ASSISTANT may delete only a
--    group they created (rooms.created_by = them). Agents cannot.
--
-- delete_room deliberately does NOT call private.is_room_admin — it keys
-- off private.current_user_role() and rooms.created_by, so it never
-- depends on the function-ownership fix from 0010.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Let assistants create groups (creator becomes room admin, as before).
--    Only the guard changes: assert_manager -> assert_staff.
-- ------------------------------------------------------------
create or replace function public.create_group_room(
  p_name text, p_member_ids uuid[] default '{}', p_avatar_url text default null
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
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
-- 2. delete_room — full group teardown. Returns the attachment object
--    paths it orphaned so the caller can sweep them from storage (the
--    DB has no FK into the storage bucket). call_signals cascade on the
--    room delete; audit rows are detached (room_id -> null), not lost.
-- ------------------------------------------------------------
create or replace function public.delete_room(p_room_id uuid)
returns text[]
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
  v_paths text[];
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then
    raise exception 'room not found';
  end if;
  if v_room.type <> 'group' then
    raise exception 'only groups can be deleted' using errcode = '42501';
  end if;

  -- Admin deletes any group; manager/assistant only a group they created.
  if not (v_actor_role = 'admin' or v_room.created_by = v_actor) then
    raise exception 'you can only delete a group you created'
      using errcode = '42501';
  end if;

  -- Collect attachment object paths before the message rows go away.
  select coalesce(array_agg(attachment_path), '{}'::text[])
    into v_paths
    from messages
   where room_id = p_room_id and attachment_path is not null;

  -- Record the deletion detached from the room, then detach any other
  -- audit rows so the trail survives the room delete (nullable FK).
  perform private.audit(v_actor, 'room.deleted', 'room', p_room_id, null::uuid,
    jsonb_build_object('name', v_room.name, 'type', v_room.type));
  update audit_logs set room_id = null where room_id = p_room_id;

  -- Contents first (only call_signals cascade), then the room itself.
  delete from messages where room_id = p_room_id;
  delete from room_members where room_id = p_room_id;
  delete from rooms where id = p_room_id;

  return v_paths;
end;
$$;

revoke execute on function public.delete_room(uuid) from public, anon;
grant execute on function public.delete_room(uuid) to authenticated;
