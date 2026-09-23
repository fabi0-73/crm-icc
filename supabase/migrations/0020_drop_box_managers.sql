-- ============================================================
-- 0020 — managers review drop-box rooms too
-- ============================================================
-- 0019 let only admins read a drop box. Managers supervise the ICC
-- Appointments Group, so they need the same view of it.
--
-- SCOPE MATTERS HERE. The messages_select policy carries a GLOBAL admin
-- bypass (from 0010): role = 'admin' reads every message in every room,
-- including other people's DMs. Managers are NOT added to that. The
-- permission below sits inside the membership branch, so a manager sees
-- everything in a drop-box room *they belong to* and gains nothing
-- anywhere else.

-- One concept, used by all three doors, replacing 0019's is_admin.
create or replace function private.drop_box_reviewer(p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = p_user
      and is_active
      and role in ('admin', 'manager')
  )
$$;

alter function private.drop_box_reviewer(uuid) owner to postgres;

-- ------------------------------------------------------------
-- Door 1: the policy. Identical to 0019 except for the last OR.
-- ------------------------------------------------------------
drop policy if exists messages_select on public.messages;
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
        and (
          not private.room_own_messages_only(messages.room_id)
          or messages.sender_id = auth.uid()
          or messages.sender_id is null
          -- Membership is already required above, so this cannot reach a
          -- room the manager is not in.
          or private.drop_box_reviewer(auth.uid())
        )
    )
  )
);

-- ------------------------------------------------------------
-- Door 2: the sidebar preview and unread badge.
-- ------------------------------------------------------------
create or replace function public.get_my_rooms()
returns table (
  room_id uuid, name text, display_name text, type text, agent_id uuid,
  avatar_url text, dm_other_user_id uuid, last_message_at timestamptz,
  last_message_body text, last_message_kind text, last_message_sender text,
  unread_count bigint
)
language sql stable security definer
set search_path = public
as $$
  select
    r.id,
    r.name,
    case when r.type = 'dm'
         then coalesce(nullif(btrim(dm.public_name), ''), dm.full_name, 'Direct message')
         else r.name end,
    r.type,
    r.agent_id,
    r.avatar_url,
    dm.user_id,
    lm.created_at,
    left(lm.body, 140),
    lm.kind,
    coalesce(nullif(btrim(lp.public_name), ''), lp.full_name),
    coalesce(uc.cnt, 0)
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  left join lateral (
    select rm2.user_id, p2.full_name, p2.public_name
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
      and (
        not r.own_messages_only
        or private.drop_box_reviewer(auth.uid())
        or m.sender_id = auth.uid()
        or m.sender_id is null
      )
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
      and (
        not r.own_messages_only
        or private.drop_box_reviewer(auth.uid())
        or m.sender_id is null
      )
  ) uc on true
  where rm.user_id = auth.uid()
    and private.current_user_role() is not null
  order by coalesce(lm.created_at, r.created_at) desc
$$;

-- ------------------------------------------------------------
-- Door 3: attachments.
-- ------------------------------------------------------------
create or replace function private.can_access_attachment(p_path text, p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.messages m
    join public.room_members rm
      on rm.room_id = m.room_id and rm.user_id = p_user
    where m.attachment_path = p_path
      and (rm.can_view_history_from is null
           or m.created_at >= rm.can_view_history_from)
      and (
        not private.room_own_messages_only(m.room_id)
        or m.sender_id = p_user
        or m.sender_id is null
        or private.drop_box_reviewer(p_user)
      )
  )
$$;

-- 0019's is_admin is now unused; drop_box_reviewer replaced it.
drop function if exists private.is_admin(uuid);
