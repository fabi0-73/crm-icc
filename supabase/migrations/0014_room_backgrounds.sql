-- ============================================================
-- 0014 — group chat backgrounds (additive, live-safe)
--
-- A wallpaper behind messages in group rooms only. DMs and agent
-- workspaces stay plain. Does not replace get_my_rooms().
-- Who may set it: the app Admin role, or a group admin of that room.
-- ============================================================

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

grant execute on function public.set_room_background(uuid, text) to authenticated;
revoke execute on function public.set_room_background(uuid, text) from anon;

-- Members already watching a group should see a new wallpaper live.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end $$;
