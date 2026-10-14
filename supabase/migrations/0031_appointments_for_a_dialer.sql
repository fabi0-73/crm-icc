-- ============================================================
-- 0031 — admins and managers post an appointment for a dialer
-- ============================================================
-- Asked for: when an admin enters an appointment, it should carry the
-- dialer's name and the date the appointment was booked. Until now the
-- dialer was always the person posting, and the booking day always today.
--
-- An admin, or a manager in the group, may now pick:
--   * the dialer — any active member of the group. The appointment is
--     theirs in every way: the chat post is sent under their name (so they
--     see it in their drop box), and the counts and the Excel credit them;
--   * the day it was booked — today's shift or an earlier one, never a
--     later one. Counts and the export file it under that day.
-- Such a post says so: "Booked:" and "Entered by:" lines in the message,
-- and appointments.entered_by records who typed it in.
--
-- A dialer posting for themselves sees and gets exactly what they did
-- before. The counts now use an appointment's own booking day instead of
-- the day its message was sent; for every existing appointment the two are
-- the same day.

alter table public.appointments
  add column if not exists entered_by uuid references public.profiles (id);

-- ------------------------------------------------------------
-- The chat text of an appointment, used by create and update.
-- ------------------------------------------------------------
create or replace function private.appointment_body(a public.appointments)
returns text
language sql stable security definer
set search_path = public
as $$
  select '📅 Appointment' || E'\n'
    || 'Dialer: ' || a.dialer_name || E'\n'
    || case when a.entered_by is not null and a.entered_by <> a.created_by
            then 'Booked: ' || to_char(a.shift_day, 'Dy, Mon FMDD, YYYY') || E'\n'
            else '' end
    || 'Agent: ' || a.agent_name || E'\n'
    || 'Policy #: ' || coalesce(a.policy_number, '—') || E'\n'
    || 'Client: ' || a.client_name || E'\n'
    || 'Phone: ' || a.phone || E'\n'
    || 'When: ' || to_char(a.appt_date, 'Dy, Mon FMDD, YYYY') || ' · '
    || to_char(a.appt_time, 'FMHH12:MI AM')
    || coalesce(' ' || a.appt_tz, '')
    || case when a.entered_by is not null and a.entered_by <> a.created_by
            then E'\n' || 'Entered by: ' || coalesce(
                   (select coalesce(nullif(btrim(p.public_name), ''), p.full_name)
                    from public.profiles p where p.id = a.entered_by), '—')
            else '' end
$$;

alter function private.appointment_body(public.appointments) owner to postgres;

-- ------------------------------------------------------------
-- create_appointment (0025) + p_dialer_id, p_booked_on. Replaced, not
-- overloaded: two versions would make every call ambiguous. Callers that
-- pass only the first nine arguments (tabs on the previous build) get the
-- old behaviour through the defaults.
-- ------------------------------------------------------------
drop function if exists public.create_appointment(uuid, text, text, text, text, text, date, time, text);

create function public.create_appointment(
  p_room      uuid,
  p_dialer    text,
  p_agent     text,
  p_policy    text,
  p_client    text,
  p_phone     text,
  p_date      date,
  p_time      time,
  p_tz        text default null,
  p_dialer_id uuid default null,
  p_booked_on date default null
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_dialer  uuid := coalesce(p_dialer_id, auth.uid());
  v_today   date := private.shift_day(now());
  v_day     date := coalesce(p_booked_on, private.shift_day(now()));
  v_name    text;
  v_agent   text;
  v_policy  text := nullif(btrim(coalesce(p_policy, '')), '');
  v_client  text := nullif(btrim(coalesce(p_client, '')), '');
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tz      text := nullif(upper(btrim(coalesce(p_tz, ''))), '');
  v_for_other boolean;
  v_msg     uuid;
  v_appt    appointments%rowtype;
begin
  if v_me is null
     or private.current_user_role() is null
     or not private.is_room_member(p_room, v_me) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from rooms where id = p_room and appointment_form) then
    raise exception 'this conversation does not take appointments'
      using errcode = '22023';
  end if;

  v_for_other := v_dialer <> v_me or v_day <> v_today;
  if v_for_other and not private.drop_box_reviewer(v_me) then
    raise exception 'only admins and managers can post for another dialer or day'
      using errcode = '42501';
  end if;
  if v_day > v_today then
    raise exception 'the booking day cannot be in the future' using errcode = '22023';
  end if;
  if v_day < v_today - 366 then
    raise exception 'the booking day is too far back' using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(p.public_name), ''), p.full_name) into v_name
  from profiles p
  where p.id = v_dialer and p.is_active
    and private.is_room_member(p_room, p.id);
  if v_name is null then
    raise exception 'the dialer must be an active member of this group'
      using errcode = '22023';
  end if;

  select a.name into v_agent from appointment_agents a
  where a.active
    and lower(btrim(a.name)) = lower(regexp_replace(btrim(coalesce(p_agent, '')), '\s+', ' ', 'g'));
  if v_agent is null then
    raise exception 'pick the agent from the list' using errcode = '22023';
  end if;
  if v_client is null or v_phone is null or p_date is null or p_time is null then
    raise exception 'agent, client, phone, date and time are required'
      using errcode = '22023';
  end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 7 then
    raise exception 'that phone number is too short' using errcode = '22023';
  end if;
  if greatest(length(v_client), length(v_phone),
              length(coalesce(v_policy, '')), length(coalesce(v_tz, ''))) > 200 then
    raise exception 'a field is too long' using errcode = '22023';
  end if;

  -- The row as it will be stored, so the message text comes out of the
  -- same function an edit uses; the message must exist first (message_id).
  v_appt.created_by    := v_dialer;
  v_appt.entered_by    := v_me;
  v_appt.shift_day     := v_day;
  v_appt.dialer_name   := v_name;
  v_appt.agent_name    := v_agent;
  v_appt.policy_number := v_policy;
  v_appt.client_name   := v_client;
  v_appt.phone         := v_phone;
  v_appt.appt_date     := p_date;
  v_appt.appt_time     := p_time;
  v_appt.appt_tz       := v_tz;

  -- The post is the dialer's: sent under their name, so their drop box
  -- shows it and the counts credit them.
  insert into messages (room_id, sender_id, kind, body, metadata)
  values (p_room, v_dialer, 'text', private.appointment_body(v_appt),
          jsonb_build_object('event', 'appointment'))
  returning id into v_msg;

  insert into appointments (
    room_id, message_id, created_by, entered_by, shift_day, dialer_name,
    agent_name, policy_number, client_name, phone, appt_date, appt_time, appt_tz
  ) values (
    p_room, v_msg, v_dialer, v_me, v_day, v_name,
    v_agent, v_policy, v_client, v_phone, p_date, p_time, v_tz
  );

  return v_msg;
end;
$$;

alter function public.create_appointment(uuid, text, text, text, text, text, date, time, text, uuid, date) owner to postgres;
revoke all on function public.create_appointment(uuid, text, text, text, text, text, date, time, text, uuid, date) from public, anon;
grant execute on function public.create_appointment(uuid, text, text, text, text, text, date, time, text, uuid, date) to authenticated;

-- ------------------------------------------------------------
-- update_appointment (0027): the same, but the message is rebuilt with
-- private.appointment_body so an entered-for-someone post keeps its
-- "Booked:" and "Entered by:" lines.
-- ------------------------------------------------------------
create or replace function public.update_appointment(
  p_message uuid,
  p_agent   text,
  p_policy  text,
  p_client  text,
  p_phone   text,
  p_date    date,
  p_time    time,
  p_tz      text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_appt    appointments%rowtype;
  v_agent   text;
  v_policy  text := nullif(btrim(coalesce(p_policy, '')), '');
  v_client  text := nullif(btrim(coalesce(p_client, '')), '');
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tz      text := nullif(upper(btrim(coalesce(p_tz, ''))), '');
  v_typed   text := lower(regexp_replace(btrim(coalesce(p_agent, '')), '\s+', ' ', 'g'));
begin
  select a.* into v_appt
  from appointments a
  join messages m on m.id = a.message_id and m.deleted_at is null
  where a.message_id = p_message;
  if v_appt.id is null then
    raise exception 'appointment not found' using errcode = 'P0002';
  end if;
  if not private.can_edit_form_post(v_appt.room_id, v_appt.created_by) then
    raise exception 'you can only edit your own appointments' using errcode = '42501';
  end if;

  select a.name into v_agent from appointment_agents a
  where a.active and lower(btrim(a.name)) = v_typed;
  if v_agent is null and lower(btrim(v_appt.agent_name)) = v_typed then
    v_agent := v_appt.agent_name;
  end if;
  if v_agent is null then
    raise exception 'pick the agent from the list' using errcode = '22023';
  end if;
  if v_client is null or v_phone is null or p_date is null or p_time is null then
    raise exception 'agent, client, phone, date and time are required'
      using errcode = '22023';
  end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 7 then
    raise exception 'that phone number is too short' using errcode = '22023';
  end if;
  if greatest(length(v_client), length(v_phone),
              length(coalesce(v_policy, '')), length(coalesce(v_tz, ''))) > 200 then
    raise exception 'a field is too long' using errcode = '22023';
  end if;

  update appointments
  set agent_name = v_agent, policy_number = v_policy, client_name = v_client,
      phone = v_phone, appt_date = p_date, appt_time = p_time, appt_tz = v_tz,
      updated_at = now(), updated_by = auth.uid()
  where id = v_appt.id
  returning * into v_appt;

  update messages
  set body = private.appointment_body(v_appt), edited_at = now()
  where id = p_message;
end;
$$;

-- The stored booking day, so the edit form can show it.
drop function if exists public.appointment_for_message(uuid);
create function public.appointment_for_message(p_message uuid)
returns table (
  agent_name text, policy_number text, client_name text, phone text,
  appt_date date, appt_time time, appt_tz text, dialer_name text,
  shift_day date
)
language sql stable security definer
set search_path = public
as $$
  select a.agent_name, a.policy_number, a.client_name, a.phone,
         a.appt_date, a.appt_time, a.appt_tz, a.dialer_name, a.shift_day
  from appointments a
  join messages m on m.id = a.message_id and m.deleted_at is null
  where a.message_id = p_message
    and private.can_edit_form_post(a.room_id, a.created_by)
$$;

alter function public.appointment_for_message(uuid) owner to postgres;
revoke all on function public.appointment_for_message(uuid) from public, anon;
grant execute on function public.appointment_for_message(uuid) to authenticated;

-- ------------------------------------------------------------
-- Counts (0024): an appointment counts on its booking day; any other post
-- on the day it was sent. Otherwise identical.
-- ------------------------------------------------------------
create or replace function public.room_post_counts_range(
  p_room uuid,
  p_from date,
  p_to   date
)
returns table (
  user_id uuid,
  person text,
  appointments bigint,
  other_posts bigint,
  from_day date,
  to_day date
)
language sql stable security definer
set search_path = public
as $$
  with posts as (
    select
      m.id,
      m.sender_id,
      m.created_at,
      coalesce(a.shift_day, private.shift_day(m.created_at)) as d,
      (a.id is not null or private.looks_like_appointment(m.body)) as is_appt,
      case
        when a.id is not null then
          right(regexp_replace(a.phone, '[^0-9]', '', 'g'), 10)
          || '|' || a.appt_date::text || '|' || lower(btrim(a.client_name))
        else private.phone_key(m.body)
      end as client_key
    from public.messages m
    left join public.appointments a on a.message_id = m.id
    where m.room_id = p_room
      and m.sender_id is not null
      and m.deleted_at is null
      and coalesce(a.shift_day, private.shift_day(m.created_at)) between p_from and p_to
  ),
  -- One appointment per client per shift: the first post wins.
  firsts as (
    select distinct on (d, coalesce(client_key, id::text)) id
    from posts
    where is_appt
    order by d, coalesce(client_key, id::text), created_at
  ),
  per as (
    select
      sender_id,
      count(*) filter (where id in (select id from firsts)) as appts,
      count(*) filter (where not is_appt) as other
    from posts
    group by sender_id
  ),
  people as (
    select rm.user_id from public.room_members rm where rm.room_id = p_room
    union
    select sender_id from per
  )
  select
    pp.user_id,
    coalesce(nullif(btrim(p.public_name), ''), p.full_name) as person,
    coalesce(per.appts, 0) as appointments,
    coalesce(per.other, 0) as other_posts,
    p_from,
    p_to
  from people pp
  join public.profiles p on p.id = pp.user_id
  left join per on per.sender_id = pp.user_id
  where p_from <= p_to
    and private.current_user_role() is not null
    and (
      exists (
        select 1 from public.room_members me
        where me.room_id = p_room and me.user_id = auth.uid()
      )
      or private.current_user_role() = 'admin'
    )
    and (
      private.drop_box_reviewer(auth.uid())
      or pp.user_id = auth.uid()
    )
  order by appointments desc, other_posts desc, person asc
$$;

notify pgrst, 'reload schema';
