-- ============================================================
-- 0018 — receipts stop writing when nothing changed
-- ============================================================
-- Both receipt functions wrote a new room_members row version on every
-- call, whether or not the stamp moved: opening a chat, switching tabs,
-- and every socket rejoin (reconcile -> mark_room_read) wrote one.
--
-- Every such write is replicated by Realtime to every open tab of that
-- chat (ChatRoom subscribes to room_members for the whole room, to draw
-- the ticks), and each delivery costs an RLS check. In a 40-person group
-- one message produced ~54 writes and ~2000 realtime deliveries, most of
-- them carrying no new information.
--
-- After this migration a receipt writes only when the stamp actually
-- moves forward, and a read counts as a delivery — reading a message
-- proves it arrived — so an open chat needs one write per burst instead
-- of two. Behaviour is unchanged: the same ticks appear, a second or two
-- later at most.

-- ------------------------------------------------------------
-- mark_room_read — no-op unless someone else's message is newer
-- than this reader's last_read_at.
-- ------------------------------------------------------------
create or replace function public.mark_room_read(p_room_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members rm
  set last_read_at = now(),
      last_delivered_at = now()
  where rm.room_id = p_room_id
    and rm.user_id = auth.uid()
    and exists (
      select 1
      from public.messages m
      where m.room_id = p_room_id
        and m.created_at > rm.last_read_at
        and m.sender_id is distinct from auth.uid()
    )
$$;

-- ------------------------------------------------------------
-- mark_room_delivered — now acknowledges a specific point in time,
-- so a repeat call for already-acknowledged messages writes nothing.
--
-- The one-argument form callers used before still resolves to this
-- function (p_at defaults to now()), so tabs running the previous build
-- keep working across the deploy.
-- ------------------------------------------------------------
drop function if exists public.mark_room_delivered(uuid);

create function public.mark_room_delivered(
  p_room_id uuid,
  p_at timestamptz default null
)
returns void
language sql security definer
set search_path = public
as $$
  update public.room_members rm
  set last_delivered_at = coalesce(p_at, now())
  where rm.room_id = p_room_id
    and rm.user_id = auth.uid()
    and private.current_user_role() is not null
    and (
      rm.last_delivered_at is null
      or rm.last_delivered_at < coalesce(p_at, now())
    )
$$;

revoke execute on function public.mark_room_delivered(uuid, timestamptz)
  from public, anon;
grant execute on function public.mark_room_delivered(uuid, timestamptz)
  to authenticated;
