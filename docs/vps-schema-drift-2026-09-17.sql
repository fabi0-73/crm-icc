-- update_my_avatar_url / set_room_background (live definitions)
CREATE OR REPLACE FUNCTION public.set_room_background(p_room_id uuid, p_background_url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.update_my_avatar_url(p_avatar_url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
-- grants
grant execute on function public.set_room_background(p_room_id uuid, p_background_url text) to authenticated;
grant execute on function public.set_room_background(p_room_id uuid, p_background_url text) to anon;
grant execute on function public.update_my_avatar_url(p_avatar_url text) to authenticated;
grant execute on function public.update_my_avatar_url(p_avatar_url text) to anon;
-- columns
alter table public.profiles add column if not exists avatar_url text;
alter table public.rooms add column if not exists background_url text;
-- storage policies on avatars bucket
policy avatars_delete on storage.objects for DELETE using (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = 'users'::text) AND ((storage.foldername(name))[2] = (uid())::text))) with check ();
policy avatars_insert on storage.objects for INSERT using () with check (((bucket_id = 'avatars'::text) AND (private.current_user_role() IS NOT NULL) AND ((((storage.foldername(name))[1] = 'groups'::text) AND (private.current_user_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'assistant'::text]))) OR (((storage.foldername(name))[1] = 'users'::text) AND ((storage.foldername(name))[2] = (uid())::text)))));
policy avatars_update on storage.objects for UPDATE using (((bucket_id = 'avatars'::text) AND (private.current_user_role() IS NOT NULL) AND ((((storage.foldername(name))[1] = 'groups'::text) AND (private.current_user_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'assistant'::text]))) OR (((storage.foldername(name))[1] = 'users'::text) AND ((storage.foldername(name))[2] = (uid())::text))))) with check ();
