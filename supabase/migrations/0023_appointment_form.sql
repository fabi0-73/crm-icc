-- ============================================================
-- 0023 — appointments entered through a form, exported to Excel
-- ============================================================
-- The team wants every appointment in a spreadsheet: today's date, the
-- dialer, the agent, policy #, client name, phone, appointment date and
-- time. Free-text posts come in too many styles to read reliably (see the
-- notes on private.looks_like_appointment in 0022), so the spreadsheet is
-- fed ONLY by a form: each field is stored as typed, and the same function
-- posts a readable message in the group, so the chat looks as it always
-- has and the counts tab still counts it.
--
-- Visibility follows the group's own rule (0019/0020): a person exports
-- their own appointments; admins and managers export everyone's.

alter table public.rooms
  add column if not exists appointment_form boolean not null default false;

-- The ICC Appointments Group.
update public.rooms
set appointment_form = true
where id = '06b05e7b-682c-4104-8952-34dcec491f3b';

create table if not exists public.appointments (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  -- The chat message that announced it. Deleting that message (a soft
  -- delete, 0009) takes the appointment out of the export.
  message_id    uuid not null references public.messages (id) on delete cascade,
  created_by    uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  -- The work day it was booked on (noon to noon, Tirane — 0022).
  shift_day     date not null,
  dialer_name   text not null,
  agent_name    text not null,
  policy_number text,
  client_name   text not null,
  phone         text not null,
  appt_date     date not null,
  appt_time     time not null,
  -- The client's time zone as the dialer gave it (EST, CST, MST, PST…).
  appt_tz       text
);

create index if not exists appointments_by_room_day
  on public.appointments (room_id, shift_day);

alter table public.appointments owner to postgres;

-- No policies: nothing reads or writes this table directly. The two
-- functions below are the only doors, and each applies the rules itself.
alter table public.appointments enable row level security;

-- ------------------------------------------------------------
-- Post an appointment: the structured row and its chat message together.
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
  v_dialer  text := nullif(btrim(coalesce(p_dialer, '')), '');
  v_agent   text := nullif(btrim(coalesce(p_agent, '')), '');
  v_policy  text := nullif(btrim(coalesce(p_policy, '')), '');
  v_client  text := nullif(btrim(coalesce(p_client, '')), '');
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_tz      text := nullif(upper(btrim(coalesce(p_tz, ''))), '');
  v_msg     uuid;
begin
  -- The same gate as posting any message (messages_insert, 0002).
  if v_me is null
     or private.current_user_role() is null
     or not private.is_room_member(p_room, v_me) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from rooms where id = p_room and appointment_form) then
    raise exception 'this conversation does not take appointments'
      using errcode = '22023';
  end if;
  if v_dialer is null or v_agent is null or v_client is null
     or v_phone is null or p_date is null or p_time is null then
    raise exception 'dialer, agent, client, phone, date and time are required'
      using errcode = '22023';
  end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 7 then
    raise exception 'that phone number is too short' using errcode = '22023';
  end if;
  if greatest(length(v_dialer), length(v_agent), length(v_client),
              length(v_phone), length(coalesce(v_policy, '')),
              length(coalesce(v_tz, ''))) > 200 then
    raise exception 'a field is too long' using errcode = '22023';
  end if;

  -- Readable in the chat, and still an appointment to the counts tab
  -- (a phone number plus a month name — private.looks_like_appointment).
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
revoke all on function public.create_appointment(uuid, text, text, text, text, text, date, time, text) from public, anon;
grant execute on function public.create_appointment(uuid, text, text, text, text, text, date, time, text) to authenticated;

-- ------------------------------------------------------------
-- The spreadsheet's rows for a named period (the counts tab's periods).
-- ------------------------------------------------------------
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
  with bounds as (
    select
      case p_period
        when 'today' then private.shift_day(now())
        when 'week'  then date_trunc('week',  private.shift_day(now()))::date
        when 'month' then date_trunc('month', private.shift_day(now()))::date
        else '2000-01-01'::date
      end as d_from,
      private.shift_day(now()) as d_to
  )
  select
    a.shift_day, a.dialer_name, a.agent_name, a.policy_number,
    a.client_name, a.phone, a.appt_date, a.appt_time, a.appt_tz,
    coalesce(p.full_name, '') as posted_by, a.created_at,
    b.d_from, b.d_to
  from appointments a
  cross join bounds b
  join messages m on m.id = a.message_id and m.deleted_at is null
  left join profiles p on p.id = a.created_by
  where a.room_id = p_room
    and a.shift_day between b.d_from and b.d_to
    and private.current_user_role() is not null
    -- Own rows; admins and managers see everyone's (as in the group itself).
    and (a.created_by = auth.uid() or private.drop_box_reviewer(auth.uid()))
  order by a.created_at
$$;

alter function public.appointments_export(uuid, text) owner to postgres;
revoke all on function public.appointments_export(uuid, text) from public, anon;
grant execute on function public.appointments_export(uuid, text) to authenticated;

notify pgrst, 'reload schema';
