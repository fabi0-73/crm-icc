-- ============================================================
-- 0012 — user profile pictures
--
-- Public URL on profiles (same pattern as rooms.avatar_url).
-- Users write only their own row and only objects under
-- avatars/users/{their id}/. Admins cannot set someone else's
-- picture through this path.
-- ============================================================

alter table public.profiles
  add column if not exists avatar_url text;

-- Any signed-in active role may set or clear their own picture.
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

grant execute on function public.update_my_avatar_url(text) to authenticated;
revoke execute on function public.update_my_avatar_url(text) from anon;

-- Group uploads stay staff-only; every role may write their own folder.
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

-- Direct-message rows reuse avatar_url for the other person's picture
-- (group rooms still use rooms.avatar_url). Same return shape as 0010.
create or replace function public.get_my_rooms()
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
  select * from (
    select
      r.id as room_id,
      r.name as name,
      case when r.type = 'dm'
           then coalesce(nullif(btrim(dm.public_name), ''), dm.full_name, 'Direct message')
           else r.name end as display_name,
      r.type as type,
      r.agent_id as agent_id,
      case when r.type = 'dm' then dm.avatar_url else r.avatar_url end as avatar_url,
      dm.user_id as dm_other_user_id,
      lm.created_at as last_message_at,
      left(lm.body, 140) as last_message_body,
      lm.kind as last_message_kind,
      coalesce(nullif(btrim(lp.public_name), ''), lp.full_name) as last_message_sender,
      coalesce(uc.cnt, 0) as unread_count
    from public.room_members rm
    join public.rooms r on r.id = rm.room_id
    left join lateral (
      select rm2.user_id, p2.full_name, p2.public_name, p2.avatar_url
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

    union all

    select
      r.id as room_id,
      r.name as name,
      case when r.type = 'dm'
           then coalesce(nullif(btrim(dm.public_name), ''), dm.full_name, 'Direct message')
           else r.name end as display_name,
      r.type as type,
      r.agent_id as agent_id,
      case when r.type = 'dm' then dm.avatar_url else r.avatar_url end as avatar_url,
      dm.user_id as dm_other_user_id,
      lm.created_at as last_message_at,
      left(lm.body, 140) as last_message_body,
      lm.kind as last_message_kind,
      coalesce(nullif(btrim(lp.public_name), ''), lp.full_name) as last_message_sender,
      0::bigint as unread_count
    from public.rooms r
    left join lateral (
      select rm2.user_id, p2.full_name, p2.public_name, p2.avatar_url
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
      order by m.created_at desc
      limit 1
    ) lm on true
    left join public.profiles lp on lp.id = lm.sender_id
    where private.current_user_role() = 'admin'
      and not exists (
        select 1 from public.room_members mine
        where mine.room_id = r.id and mine.user_id = auth.uid()
      )
  ) rooms
  order by last_message_at desc nulls last
$$;

alter publication supabase_realtime add table public.profiles;
