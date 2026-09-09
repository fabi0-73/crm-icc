-- ============================================================
-- 0009_message_actions.sql
-- Message edit / reply / delete, and tighter group-membership rules.
--
--  * reply_to: a message may quote another in the same room.
--  * edited_at / deleted_at: edits stamp a time; deletes are soft
--    tombstones (the row stays so realtime carries the change and the
--    thread doesn't develop holes), and a deleted attachment's storage
--    object is removed so the file is no longer retrievable.
--  * add_room_member / leave_room are narrowed so a plain assistant
--    (a member who is not a group admin) can neither add others nor
--    leave on their own — group membership is an admin/manager action.
-- ============================================================

alter table public.messages
  add column if not exists reply_to  uuid references public.messages(id) on delete set null,
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

-- ------------------------------------------------------------
-- edit_message — the sender edits the text of their own message.
-- ------------------------------------------------------------
create or replace function public.edit_message(p_id uuid, p_body text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_msg messages%rowtype;
begin
  select * into v_msg from messages where id = p_id;
  if not found then raise exception 'message not found'; end if;
  if v_msg.deleted_at is not null then raise exception 'message was deleted'; end if;
  if v_msg.kind <> 'text' then raise exception 'only text messages can be edited'; end if;
  if v_msg.sender_id is distinct from v_actor then
    raise exception 'you can only edit your own messages' using errcode = '42501';
  end if;
  if coalesce(trim(p_body), '') = '' then
    raise exception 'message cannot be empty';
  end if;

  update messages set body = trim(p_body), edited_at = now() where id = p_id;
end;
$$;

-- ------------------------------------------------------------
-- delete_message — sender, a group admin, or an app admin/manager
-- soft-deletes a message. A file's storage object is removed too.
-- ------------------------------------------------------------
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
    where bucket_id = 'attachments' and name = v_msg.attachment_path;
  end if;

  update messages set deleted_at = now(), body = '', metadata = null where id = p_id;
end;
$$;

-- ------------------------------------------------------------
-- #3 Tighten group membership: adding and leaving are admin/manager
-- actions. Assistants who are plain members can do neither.
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

  -- Groups and workspaces alike: only an app admin/manager or a room
  -- admin may add members.
  if not (v_actor_role in ('admin', 'manager')
          or private.is_room_admin(p_room_id, v_actor)) then
    raise exception 'only group admins can add members' using errcode = '42501';
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

create or replace function public.leave_room(p_room_id uuid)
returns void
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
  if v_room.type <> 'group' then
    raise exception 'you can only leave group chats';
  end if;
  -- Leaving is a membership change; assistants are placed and removed by
  -- an admin, so only app admins/managers or a group admin may leave.
  if not (v_actor_role in ('admin', 'manager')
          or private.is_room_admin(p_room_id, v_actor)) then
    raise exception 'ask a group admin to remove you' using errcode = '42501';
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
-- Grants
-- ------------------------------------------------------------
revoke execute on function
  public.edit_message(uuid, text),
  public.delete_message(uuid)
from public, anon;

grant execute on function
  public.edit_message(uuid, text),
  public.delete_message(uuid)
to authenticated;
