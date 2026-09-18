-- ============================================================
-- 0015_profile_avatars_room_backgrounds.sql
--
-- Records schema that has been LIVE since the 2026-09-17 deploy but was
-- applied without any migration file in this repo: profile pictures for
-- every role, and wallpapers for group chats.
--
-- Written to reproduce production exactly, so running it against the live
-- database changes nothing except the grants noted below. Every statement
-- is idempotent (IF NOT EXISTS / OR REPLACE / guarded DO blocks). Function
-- bodies and policies are taken from the parallel GitHub line's
-- 0013_profile_avatars.sql / 0014_room_backgrounds.sql (commit c22d37a),
-- which were verified identical to what is running.
--
-- One deliberate difference from that source: its `revoke ... from anon`
-- never took effect, because Postgres grants EXECUTE to PUBLIC by default
-- and anon inherits it through PUBLIC. Both functions therefore stayed
-- callable by logged-out users. They refuse such callers anyway (no role),
-- so this was not exploitable — but it breaks this project's convention,
-- and `revoke ... from public, anon` is what actually closes it.
-- ============================================================

-- ------------------------------------------------------------
-- Profile pictures
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_url text;

create or replace function public.update_my_avatar_url(p_avatar_url text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text := private.current_user_role();
  v_url  text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_role is null then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_url is not null and char_length(v_url) > 2000 then
    raise exception 'avatar url is too long';
  end if;
  update public.profiles
  set avatar_url = v_url
  where id = auth.uid();
end;
$$;

revoke execute on function public.update_my_avatar_url(text) from public, anon;
grant execute on function public.update_my_avatar_url(text) to authenticated;

-- Group images stay staff-only; every role may write their own folder.
drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and private.current_user_role() is not null
    and (
      (
        (storage.foldername(name))[1] = 'groups'
        and private.current_user_role() in ('admin', 'manager', 'assistant')
      )
      or (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
    )
  );

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and private.current_user_role() is not null
    and (
      (
        (storage.foldername(name))[1] = 'groups'
        and private.current_user_role() in ('admin', 'manager', 'assistant')
      )
      or (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
    )
  );

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- A new picture should appear for everyone without a refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

-- ------------------------------------------------------------
-- Group chat backgrounds (group rooms only; DMs and workspaces stay plain).
-- Who may set one: the app admin role, or a group admin of that room.
-- ------------------------------------------------------------
alter table public.rooms
  add column if not exists background_url text;

create or replace function public.set_room_background(
  p_room_id uuid,
  p_background_url text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_actor_role text := private.current_user_role();
  v_room rooms%rowtype;
  v_url text := nullif(btrim(coalesce(p_background_url, '')), '');
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then
    raise exception 'room not found';
  end if;
  if v_room.type <> 'group' then
    raise exception 'only group chats can have a background';
  end if;
  if not (
    v_actor_role = 'admin'
    or private.is_room_admin(p_room_id, v_actor)
  ) then
    raise exception 'only group admins or an admin can change the chat background'
      using errcode = '42501';
  end if;
  if v_url is not null and char_length(v_url) > 2000 then
    raise exception 'background url is too long';
  end if;

  update public.rooms
  set background_url = v_url
  where id = p_room_id;

  perform private.audit(
    v_actor,
    'room.background',
    'room',
    p_room_id,
    p_room_id,
    '{}'::jsonb
  );
end;
$$;

revoke execute on function public.set_room_background(uuid, text) from public, anon;
grant execute on function public.set_room_background(uuid, text) to authenticated;

-- Members already watching a group should see a new wallpaper live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end $$;
