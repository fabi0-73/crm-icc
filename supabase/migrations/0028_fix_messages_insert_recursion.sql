-- ============================================================
-- 0028 — fix: "infinite recursion detected in policy for relation
--        messages" on every send (from 0026)
-- ============================================================
-- 0026's messages_insert policy checked reply_to with a subquery on
-- public.messages. That subquery is itself subject to messages' RLS, which
-- Postgres reports as recursion, so no one could post. The check now runs
-- in a security-definer function, which reads messages without RLS.

create or replace function private.reply_in_room(p_reply uuid, p_room uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.messages r where r.id = p_reply and r.room_id = p_room
  )
$$;

alter function private.reply_in_room(uuid, uuid) owner to postgres;
revoke all on function private.reply_in_room(uuid, uuid) from public, anon;
grant execute on function private.reply_in_room(uuid, uuid) to authenticated;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  sender_id = auth.uid()
  and kind in ('text', 'file')
  and private.current_user_role() is not null
  and private.is_room_member(room_id, auth.uid())
  and (attachment_path is null or private.owns_upload(attachment_path, room_id))
  and (reply_to is null or private.reply_in_room(reply_to, room_id))
);
