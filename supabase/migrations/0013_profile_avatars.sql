-- ============================================================
-- 0013 — user profile pictures (additive, live-safe)
--
-- Use this on the live database. It does not replace get_my_rooms().
-- 0012 on this GitHub repo already added the same objects for a
-- fresh install; everything here is IF NOT EXISTS / OR REPLACE.
-- ============================================================

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

-- Skip if profiles is already in the publication (re-adding errors).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;
