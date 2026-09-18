-- ============================================================
-- 0017_notification_mutes.sql
--
-- Mutes move from the browser to the database.
--
-- Until now a mute was a list of room ids in one browser's localStorage.
-- The server never saw it, so a muted chat still sent push notifications
-- to a closed app, and muting on the laptop did nothing on the phone.
--
-- One row per thing a person has muted: a whole conversation (room_id) or
-- one person everywhere (muted_user_id). Mutes silence message sounds,
-- pop-ups and push notifications; calls still ring.
--
-- Private to the person who set it — nobody else can see that someone
-- muted them or a group. The push sender reads it with the service role.
-- ============================================================

create table if not exists public.notification_mutes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid()
    references public.profiles(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  muted_user_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint notification_mutes_one_target
    check (num_nonnulls(room_id, muted_user_id) = 1),
  constraint notification_mutes_not_self
    check (muted_user_id is distinct from user_id)
);

create unique index if not exists notification_mutes_room_key
  on public.notification_mutes (user_id, room_id)
  where room_id is not null;
create unique index if not exists notification_mutes_user_key
  on public.notification_mutes (user_id, muted_user_id)
  where muted_user_id is not null;
-- The push sender asks "which of these recipients muted this room or this
-- sender?" for every message.
create index if not exists notification_mutes_room_idx
  on public.notification_mutes (room_id)
  where room_id is not null;
create index if not exists notification_mutes_muted_user_idx
  on public.notification_mutes (muted_user_id)
  where muted_user_id is not null;

alter table public.notification_mutes enable row level security;

drop policy if exists notification_mutes_select on public.notification_mutes;
create policy notification_mutes_select on public.notification_mutes
  for select to authenticated
  using (user_id = auth.uid() and private.current_user_role() is not null);

-- A room can only be muted by one of its members; a person by anyone
-- active (muting someone reveals nothing and grants nothing).
drop policy if exists notification_mutes_insert on public.notification_mutes;
create policy notification_mutes_insert on public.notification_mutes
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and private.current_user_role() is not null
    and (
      room_id is null
      or exists (
        select 1 from public.room_members rm
        where rm.room_id = notification_mutes.room_id
          and rm.user_id = auth.uid()
      )
    )
  );

drop policy if exists notification_mutes_delete on public.notification_mutes;
create policy notification_mutes_delete on public.notification_mutes
  for delete to authenticated
  using (user_id = auth.uid());

-- Supabase's default privileges hand every new public table to anon and
-- authenticated in full; narrow that to what the policies above allow.
revoke all on public.notification_mutes from public, anon, authenticated;
grant select, insert, delete on public.notification_mutes to authenticated;
