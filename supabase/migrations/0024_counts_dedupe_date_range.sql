-- ============================================================
-- 0024 — appointment counts that match reality, over any dates
-- ============================================================
-- Reported: "it doesn't count correctly". Measured on the real posts:
--
-- 1. REPOSTS. Before the form, the same client phone number turned up in
--    more than one post in a shift 9 to 24 times a shift (corrections,
--    re-posts, follow-ups), and every one counted as a new appointment —
--    roughly 8–13% too many. Now: ONE appointment per client per shift,
--    credited to whoever posted it first. A text post is keyed by its phone
--    number; a form post by phone + appointment date + client, so two
--    people booked on one household phone are still two appointments.
-- 2. PEOPLE WHO LEFT the group dropped out of the totals with all their
--    appointments (the list started from current members). Now anyone who
--    posted in the period is listed.
-- 3. DELETED posts counted towards "other posts". Now they count nowhere.
-- 4. The form's dialer was free text, so one person appeared as "Muhamed"
--    and "Muhamed Kuka". The dialer is now always the person posting — in
--    every one of the 143 form posts so far it already was — and the five
--    first-name-only rows are corrected to the full name.
--
-- Plus the date filter the team asked for: every count and export can be
-- asked for an explicit range of shift days (noon-to-noon, 0022). The named
-- periods (Shift / Week / Month / All) stay, as wrappers over the range.

-- ------------------------------------------------------------
-- A client's phone as ten digits, found in free text. The same shape the
-- counter already recognises (private.looks_like_appointment).
-- ------------------------------------------------------------
create or replace function private.phone_key(p_text text)
returns text
language sql immutable
as $$
  select nullif(right(regexp_replace(coalesce(
    substring(coalesce(p_text, '') from '[0-9]{3}[^0-9]{0,2}[0-9]{3}[^0-9]{0,2}[0-9]{4}'),
    ''), '[^0-9]', '', 'g'), 10), '')
$$;

alter function private.phone_key(text) owner to postgres;

-- ------------------------------------------------------------
-- Counts per person over shift days p_from..p_to.
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
      private.shift_day(m.created_at) as d,
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
      and private.shift_day(m.created_at) between p_from and p_to
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

alter function public.room_post_counts_range(uuid, date, date) owner to postgres;
revoke all on function public.room_post_counts_range(uuid, date, date) from public, anon;
grant execute on function public.room_post_counts_range(uuid, date, date) to authenticated;

-- The shift day a named period starts on (0022's rules, in one place).
create or replace function private.period_start(p_period text)
returns date
language sql stable
as $$
  select case p_period
    when 'today' then private.shift_day(now())
    when 'week'  then date_trunc('week',  private.shift_day(now()))::date
    when 'month' then date_trunc('month', private.shift_day(now()))::date
    else '2000-01-01'::date
  end
$$;

alter function private.period_start(text) owner to postgres;

-- The named periods, now a thin wrapper (same signature as 0022).
create or replace function public.room_post_counts(
  p_room uuid,
  p_period text default 'today'
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
  select * from public.room_post_counts_range(
    p_room, private.period_start(p_period), private.shift_day(now()))
$$;

alter function public.room_post_counts(uuid, text) owner to postgres;

-- ------------------------------------------------------------
-- The export over shift days p_from..p_to (0023's rules, dates given).
-- ------------------------------------------------------------
create or replace function public.appointments_export_range(
  p_room uuid,
  p_from date,
  p_to   date
)
returns table (
  shift_day     date,
  dialer_name   text,
  agent_name    text,
  policy_number text,
  client_name   text,
  phone         text,
  appt_date     date,
  appt_time     time,
  appt_tz       text,
  posted_by     text,
  created_at    timestamptz,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  select
    a.shift_day, a.dialer_name, a.agent_name, a.policy_number,
    a.client_name, a.phone, a.appt_date, a.appt_time, a.appt_tz,
    coalesce(p.full_name, '') as posted_by, a.created_at,
    p_from, p_to
  from public.appointments a
  join public.messages m on m.id = a.message_id and m.deleted_at is null
  left join public.profiles p on p.id = a.created_by
  where a.room_id = p_room
    and a.shift_day between p_from and p_to
    and private.current_user_role() is not null
    and (a.created_by = auth.uid() or private.drop_box_reviewer(auth.uid()))
  order by a.created_at
$$;

alter function public.appointments_export_range(uuid, date, date) owner to postgres;
revoke all on function public.appointments_export_range(uuid, date, date) from public, anon;
grant execute on function public.appointments_export_range(uuid, date, date) to authenticated;

create or replace function public.appointments_export(
  p_room   uuid,
  p_period text default 'today'
)
returns table (
  shift_day     date,
  dialer_name   text,
  agent_name    text,
  policy_number text,
  client_name   text,
  phone         text,
  appt_date     date,
  appt_time     time,
  appt_tz       text,
  posted_by     text,
  created_at    timestamptz,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  select * from public.appointments_export_range(
    p_room, private.period_start(p_period), private.shift_day(now()))
$$;

alter function public.appointments_export(uuid, text) owner to postgres;

-- ------------------------------------------------------------
-- The dialer is the person posting. p_dialer is kept in the signature so
-- tabs still on the previous build keep working; it is no longer used.
-- ------------------------------------------------------------
create or replace function public.create_appointment(
  p_room    uuid,
  p_dialer  text,
  p_agent   text,
  p_policy  text,
  p_client  text,
  p_phone   text,
  p_date    date,
  p_time    time,
  p_tz      text default null
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_dialer  text;
  v_agent   text := nullif(btrim(coalesce(p_agent, '')), '');
  v_policy  text := nullif(btrim(coalesce(p_policy, '')), '');
  v_client  text := nullif(btrim(coalesce(p_client, '')), '');
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tz      text := nullif(upper(btrim(coalesce(p_tz, ''))), '');
  v_msg     uuid;
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
  select coalesce(nullif(btrim(public_name), ''), full_name)
    into v_dialer from profiles where id = v_me;
  if v_agent is null or v_client is null
     or v_phone is null or p_date is null or p_time is null then
    raise exception 'agent, client, phone, date and time are required'
      using errcode = '22023';
  end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 7 then
    raise exception 'that phone number is too short' using errcode = '22023';
  end if;
  if greatest(length(v_agent), length(v_client), length(v_phone),
              length(coalesce(v_policy, '')), length(coalesce(v_tz, ''))) > 200 then
    raise exception 'a field is too long' using errcode = '22023';
  end if;

  insert into messages (room_id, sender_id, kind, body, metadata)
  values (
    p_room, v_me, 'text',
    '📅 Appointment' || E'\n'
      || 'Dialer: ' || v_dialer || E'\n'
      || 'Agent: ' || v_agent || E'\n'
      || 'Policy #: ' || coalesce(v_policy, '—') || E'\n'
      || 'Client: ' || v_client || E'\n'
      || 'Phone: ' || v_phone || E'\n'
      || 'When: ' || to_char(p_date, 'Dy, Mon FMDD, YYYY') || ' · '
      || to_char(p_time, 'FMHH12:MI AM')
      || coalesce(' ' || v_tz, ''),
    jsonb_build_object('event', 'appointment')
  )
  returning id into v_msg;

  insert into appointments (
    room_id, message_id, created_by, shift_day, dialer_name, agent_name,
    policy_number, client_name, phone, appt_date, appt_time, appt_tz
  ) values (
    p_room, v_msg, v_me, private.shift_day(now()), v_dialer, v_agent,
    v_policy, v_client, v_phone, p_date, p_time, v_tz
  );

  return v_msg;
end;
$$;

alter function public.create_appointment(uuid, text, text, text, text, text, date, time, text) owner to postgres;

-- The five first-name-only dialers were their own posters: use the name
-- everyone else is listed under, so the per-dialer totals don't split.
update public.appointments a
set dialer_name = coalesce(nullif(btrim(p.public_name), ''), p.full_name)
from public.profiles p
where p.id = a.created_by
  and a.dialer_name <> coalesce(nullif(btrim(p.public_name), ''), p.full_name)
  and lower(coalesce(nullif(btrim(p.public_name), ''), p.full_name))
      like lower(btrim(a.dialer_name)) || '%';

notify pgrst, 'reload schema';
