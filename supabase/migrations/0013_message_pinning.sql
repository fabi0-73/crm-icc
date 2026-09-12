-- ============================================================
-- 0013_message_pinning.sql — pin messages in groups and DMs
--
-- Only ADMINS and MANAGERS may pin or unpin. Assistants and agents can
-- SEE pins (they ride the message row, which they already read) but
-- cannot change them. The rule is enforced here, in SECURITY DEFINER
-- functions, so the client cannot bypass it — messages_update is not
-- opened up to pinning.
--
-- Pins live on the message row rather than a side table: a pin is a
-- property of the message, it disappears with the message, and it
-- arrives over the realtime UPDATE stream the chat already consumes.
-- ============================================================

alter table public.messages
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references public.profiles (id);

-- Fetching "the pins in this room" is the only new read pattern.
create index if not exists messages_pinned_idx
  on public.messages (room_id, pinned_at desc)
  where pinned_at is not null;

-- ------------------------------------------------------------
-- set_message_pinned — pin/unpin one message.
--
-- Guards: active admin/manager only; the message must exist, not be
-- deleted, and the caller must be able to see its room (member, or an
-- admin). Pinning a system row is pointless, so it's refused.
-- ------------------------------------------------------------
create or replace function public.set_message_pinned(
  p_id uuid, p_pinned boolean
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role text := private.current_user_role();
  v_msg messages%rowtype;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if v_role is null or v_role not in ('admin', 'manager') then
    raise exception 'only admins and managers can pin messages'
      using errcode = '42501';
  end if;

  select * into v_msg from messages where id = p_id;
  if not found then
    raise exception 'message not found';
  end if;
  if v_msg.deleted_at is not null then
    raise exception 'message was deleted';
  end if;
  if v_msg.kind = 'system' then
    raise exception 'system messages cannot be pinned' using errcode = '42501';
  end if;

  -- An admin can act anywhere; a manager must be in the conversation.
  if v_role <> 'admin' and not private.is_room_member(v_msg.room_id, v_actor) then
    raise exception 'you are not in this conversation' using errcode = '42501';
  end if;

  update messages
     set pinned_at = case when p_pinned then now() else null end,
         pinned_by = case when p_pinned then v_actor else null end
   where id = p_id;

  perform private.audit(
    v_actor,
    case when p_pinned then 'message.pinned' else 'message.unpinned' end,
    'message', p_id, v_msg.room_id, '{}'::jsonb);
end;
$$;

revoke execute on function public.set_message_pinned(uuid, boolean) from public, anon;
grant execute on function public.set_message_pinned(uuid, boolean) to authenticated;
