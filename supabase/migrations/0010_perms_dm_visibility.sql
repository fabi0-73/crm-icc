-- ============================================================
-- 0010_perms_dm_visibility.sql
-- Database foundation for the current batch:
--   #11  Fix "permission denied for function is_room_admin".
--   #4   Admins can read every room's messages without joining.
--   #1   Agents can hold a private DM with an assistant.
--   #3   An agent can be assigned to a manager.
-- ============================================================

-- ------------------------------------------------------------
-- #11  add_room_member / remove_room_member are owned by `postgres`
-- (created in the original schema import) and run as their definer.
-- The helpers they call, private.is_room_admin / ensure_group_has_admin,
-- were created later by `supabase_admin` and granted EXECUTE only to
-- supabase_admin. `postgres` is NOT a superuser here, so the nested call
-- was refused. Align the helpers' owner with the other private helpers
-- (assert_manager/assert_staff are postgres-owned) so every definer that
-- calls them has execute.
-- ------------------------------------------------------------
alter function private.is_room_admin(uuid, uuid) owner to postgres;
alter function private.ensure_group_has_admin(uuid) owner to postgres;

-- ------------------------------------------------------------
-- #4  Admin read-everywhere. Admins can view channel history without
-- being a member, and private agent/assistant DMs, for oversight.
-- Non-admin visibility is unchanged (still membership-scoped).
-- ------------------------------------------------------------
drop policy messages_select on public.messages;
create policy messages_select on public.messages for select using (
  private.current_user_role() is not null
  and (
    private.current_user_role() = 'admin'
    or exists (
      select 1 from public.room_members rm
      where rm.room_id = messages.room_id
        and rm.user_id = auth.uid()
        and (rm.can_view_history_from is null
             or messages.created_at >= rm.can_view_history_from)
    )
  )
);

-- ------------------------------------------------------------
-- #1  Agent <-> assistant private DM. The old rule blocked agents from
-- every DM. Now the pair is allowed when both are active and either both
-- are staff (admin/manager/assistant, unchanged) OR the pair is exactly
-- one agent + one assistant. Agents still cannot DM admins/managers or
-- other agents.
-- ------------------------------------------------------------
create or replace function public.get_or_create_dm(p_other_user uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_other_role text;
  v_key   text;
  v_room  uuid;
  v_ok    boolean;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_other_user is null or p_other_user = v_actor then
    raise exception 'cannot open a direct message with yourself';
  end if;

  select role into v_actor_role from profiles where id = v_actor and is_active;
  select role into v_other_role from profiles where id = p_other_user and is_active;
  if v_actor_role is null then raise exception 'permission denied' using errcode = '42501'; end if;
  if v_other_role is null then raise exception 'user % is not active', p_other_user; end if;

  -- Allowed pairs:
  v_ok :=
    (v_actor_role in ('admin','manager','assistant')
       and v_other_role in ('admin','manager','assistant'))
    or (v_actor_role = 'agent'      and v_other_role = 'assistant')
    or (v_actor_role = 'assistant'  and v_other_role = 'agent');
  if not v_ok then
    raise exception 'a direct message is not allowed between these accounts'
      using errcode = '42501';
  end if;

  v_key := least(v_actor, p_other_user)::text || ':' || greatest(v_actor, p_other_user)::text;

  select id into v_room from rooms where type = 'dm' and dm_key = v_key;
  if v_room is not null then
    return v_room;
  end if;

  insert into rooms (type, name, dm_key, created_by)
  values ('dm', '', v_key, v_actor)
  on conflict (dm_key) where type = 'dm' do nothing
  returning id into v_room;

  if v_room is null then
    select id into v_room from rooms where type = 'dm' and dm_key = v_key;
    return v_room;
  end if;

  insert into room_members (room_id, user_id, can_view_history_from, added_by)
  values
    (v_room, v_actor, null, v_actor),
    (v_room, p_other_user, null, v_actor);

  perform private.audit(v_actor, 'dm.created', 'room', v_room, v_room,
    jsonb_build_object('member_ids', array[v_actor, p_other_user]));

  return v_room;
end;
$$;

-- ------------------------------------------------------------
-- #3  Manager assigned to an agent. Nullable; set by an admin. Kept as a
-- simple column (one manager per agent) rather than a join table.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists manager_id uuid references public.profiles(id);

create index if not exists agents_manager_id on public.agents (manager_id);
