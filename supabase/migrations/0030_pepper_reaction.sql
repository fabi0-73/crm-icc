-- ============================================================
-- 0030 — a hot pepper reaction (🌶️)
-- ============================================================
-- toggle_reaction (0027) with 🌶️ added to the set. Must match REACTIONS in
-- src/components/MessageReactions.tsx.

create or replace function public.toggle_reaction(p_message uuid, p_emoji text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_msg  messages%rowtype;
  v_list jsonb;
  v_all  jsonb;
begin
  if p_emoji is null or p_emoji not in ('👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅', '🌶️') then
    raise exception 'that reaction is not available' using errcode = '22023';
  end if;
  select * into v_msg from messages where id = p_message for update;
  if not found or v_me is null or not private.can_see_message(v_msg, v_me) then
    raise exception 'message not found' using errcode = 'P0002';
  end if;
  if v_msg.deleted_at is not null or v_msg.kind = 'system' then
    raise exception 'this message cannot take reactions' using errcode = '22023';
  end if;

  v_all  := coalesce(v_msg.reactions, '{}'::jsonb);
  v_list := coalesce(v_all -> p_emoji, '[]'::jsonb);
  if v_list ? v_me::text then
    v_list := (select coalesce(jsonb_agg(e), '[]'::jsonb)
               from jsonb_array_elements_text(v_list) e where e <> v_me::text);
  else
    v_list := v_list || to_jsonb(v_me::text);
  end if;
  if jsonb_array_length(v_list) = 0 then
    v_all := v_all - p_emoji;
  else
    v_all := jsonb_set(v_all, array[p_emoji], v_list);
  end if;

  update messages
  set reactions = case when v_all = '{}'::jsonb then null else v_all end
  where id = p_message;
  return v_all;
end;
$$;

alter function public.toggle_reaction(uuid, text) owner to postgres;
revoke all on function public.toggle_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_reaction(uuid, text) to authenticated;

notify pgrst, 'reload schema';
