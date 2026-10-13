-- ============================================================
-- 0027 — ICC RAPORTIM works like the appointments group; form posts
--        can be edited; emoji reactions
-- ============================================================
-- The ICC RAPORTIM group gets the appointments group's set-up (0019, 0020,
-- 0023), with its own template:
--
--   Pick ups / Appt / Callbacks / Hung ups / Others / Wrong number
--   + Comments (free text, this group only)
--
--   * a drop box: a dialer sees only their own reports, while admins and
--     managers see everyone's;
--   * posts only through a form; each number is stored as typed
--     (public.shift_reports), and the same call posts a readable message;
--   * a Counts tab with each person's totals over a shift, week, month or
--     chosen dates, plus an Excel/CSV export.
--
-- Editing. A form post (an appointment or a report) is corrected through its
-- own form, never as free text: the stored row and the chat message change
-- together, so the export and the chat cannot disagree. The poster may edit;
-- so may an admin, or a manager who is in the group. A plain edit_message on
-- a form post is refused.

-- ------------------------------------------------------------
-- The switch, and the group.
-- ------------------------------------------------------------
alter table public.rooms
  add column if not exists report_form boolean not null default false;

update public.rooms
set report_form = true, own_messages_only = true
where id = '452c4622-c375-4b48-b77a-a695b24343f7';

-- ------------------------------------------------------------
-- The reports.
-- ------------------------------------------------------------
create table if not exists public.shift_reports (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms (id) on delete cascade,
  -- Deleting the chat message (a soft delete) takes the report out of the
  -- totals and the export.
  message_id    uuid not null references public.messages (id) on delete cascade,
  created_by    uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  -- The work day it was sent on (noon to noon, Tirane — 0022).
  shift_day     date not null,
  dialer_name   text not null,
  pick_ups      integer not null check (pick_ups between 0 and 100000),
  appts         integer not null check (appts between 0 and 100000),
  callbacks     integer not null check (callbacks between 0 and 100000),
  hung_ups      integer not null check (hung_ups between 0 and 100000),
  others        integer not null check (others between 0 and 100000),
  wrong_numbers integer not null check (wrong_numbers between 0 and 100000),
  comments      text check (length(comments) <= 2000),
  updated_at    timestamptz,
  updated_by    uuid references public.profiles (id)
);

create index if not exists shift_reports_by_room_day
  on public.shift_reports (room_id, shift_day);
create unique index if not exists shift_reports_message_key
  on public.shift_reports (message_id);

alter table public.shift_reports owner to postgres;
-- No policies: the functions below are the only doors.
alter table public.shift_reports enable row level security;
revoke all on public.shift_reports from anon, authenticated;

-- Who edited an appointment, and when.
alter table public.appointments
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid references public.profiles (id);

-- ------------------------------------------------------------
-- May the caller edit a form post in this room sent by p_sender?
-- ------------------------------------------------------------
create or replace function private.can_edit_form_post(p_room uuid, p_sender uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select private.current_user_role() is not null
     and (
       (p_sender = auth.uid() and private.is_room_member(p_room, auth.uid()))
       or private.current_user_role() = 'admin'
       or (private.current_user_role() = 'manager'
           and private.is_room_member(p_room, auth.uid()))
     )
$$;

alter function private.can_edit_form_post(uuid, uuid) owner to postgres;

-- ------------------------------------------------------------
-- The chat text of a report. One place, used by create and update.
-- ------------------------------------------------------------
create or replace function private.shift_report_body(
  p_pick_ups int, p_appts int, p_callbacks int, p_hung_ups int,
  p_others int, p_wrong int, p_comments text
) returns text
language sql immutable
as $$
  select '📋 Report' || E'\n'
    || 'Pick ups: ' || p_pick_ups || E'\n'
    || 'Appt: ' || p_appts || E'\n'
    || 'Callbacks: ' || p_callbacks || E'\n'
    || 'Hung ups: ' || p_hung_ups || E'\n'
    || 'Others: ' || p_others || E'\n'
    || 'Wrong number: ' || p_wrong
    || coalesce(E'\n' || 'Comments: ' || p_comments, '')
$$;

alter function private.shift_report_body(int, int, int, int, int, int, text) owner to postgres;

-- Shared checks for create and update.
create or replace function private.check_shift_report(
  p_pick_ups int, p_appts int, p_callbacks int, p_hung_ups int,
  p_others int, p_wrong int, p_comments text
) returns void
language plpgsql immutable
as $$
begin
  if p_pick_ups is null or p_appts is null or p_callbacks is null
     or p_hung_ups is null or p_others is null or p_wrong is null then
    raise exception 'fill in every number (0 if none)' using errcode = '22023';
  end if;
  if least(p_pick_ups, p_appts, p_callbacks, p_hung_ups, p_others, p_wrong) < 0
     or greatest(p_pick_ups, p_appts, p_callbacks, p_hung_ups, p_others, p_wrong) > 100000 then
    raise exception 'the numbers must be between 0 and 100000' using errcode = '22023';
  end if;
  if length(coalesce(p_comments, '')) > 2000 then
    raise exception 'comments are too long (2000 characters at most)' using errcode = '22023';
  end if;
end;
$$;

alter function private.check_shift_report(int, int, int, int, int, int, text) owner to postgres;

-- ------------------------------------------------------------
-- Send a report: the stored row and its chat message together.
-- ------------------------------------------------------------
create or replace function public.create_shift_report(
  p_room      uuid,
  p_pick_ups  int,
  p_appts     int,
  p_callbacks int,
  p_hung_ups  int,
  p_others    int,
  p_wrong     int,
  p_comments  text default null
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_me       uuid := auth.uid();
  v_dialer   text;
  v_comments text := nullif(btrim(coalesce(p_comments, '')), '');
  v_msg      uuid;
begin
  if v_me is null
     or private.current_user_role() is null
     or not private.is_room_member(p_room, v_me) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from rooms where id = p_room and report_form) then
    raise exception 'this conversation does not take reports' using errcode = '22023';
  end if;
  perform private.check_shift_report(p_pick_ups, p_appts, p_callbacks,
    p_hung_ups, p_others, p_wrong, v_comments);
  select coalesce(nullif(btrim(public_name), ''), full_name)
    into v_dialer from profiles where id = v_me;

  insert into messages (room_id, sender_id, kind, body, metadata)
  values (
    p_room, v_me, 'text',
    private.shift_report_body(p_pick_ups, p_appts, p_callbacks, p_hung_ups,
      p_others, p_wrong, v_comments),
    jsonb_build_object('event', 'report')
  )
  returning id into v_msg;

  insert into shift_reports (
    room_id, message_id, created_by, shift_day, dialer_name, pick_ups, appts,
    callbacks, hung_ups, others, wrong_numbers, comments
  ) values (
    p_room, v_msg, v_me, private.shift_day(now()), v_dialer, p_pick_ups,
    p_appts, p_callbacks, p_hung_ups, p_others, p_wrong, v_comments
  );

  return v_msg;
end;
$$;

alter function public.create_shift_report(uuid, int, int, int, int, int, int, text) owner to postgres;
revoke all on function public.create_shift_report(uuid, int, int, int, int, int, int, text) from public, anon;
grant execute on function public.create_shift_report(uuid, int, int, int, int, int, int, text) to authenticated;

-- ------------------------------------------------------------
-- Correct a report. The shift and the dialer stay as sent.
-- ------------------------------------------------------------
create or replace function public.update_shift_report(
  p_message   uuid,
  p_pick_ups  int,
  p_appts     int,
  p_callbacks int,
  p_hung_ups  int,
  p_others    int,
  p_wrong     int,
  p_comments  text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_comments text := nullif(btrim(coalesce(p_comments, '')), '');
  v_room     uuid;
  v_sender   uuid;
begin
  select m.room_id, m.sender_id into v_room, v_sender
  from messages m
  join shift_reports r on r.message_id = m.id
  where m.id = p_message and m.deleted_at is null;
  if v_room is null then
    raise exception 'report not found' using errcode = 'P0002';
  end if;
  if not private.can_edit_form_post(v_room, v_sender) then
    raise exception 'you can only edit your own reports' using errcode = '42501';
  end if;
  perform private.check_shift_report(p_pick_ups, p_appts, p_callbacks,
    p_hung_ups, p_others, p_wrong, v_comments);

  update shift_reports
  set pick_ups = p_pick_ups, appts = p_appts, callbacks = p_callbacks,
      hung_ups = p_hung_ups, others = p_others, wrong_numbers = p_wrong,
      comments = v_comments, updated_at = now(), updated_by = auth.uid()
  where message_id = p_message;

  update messages
  set body = private.shift_report_body(p_pick_ups, p_appts, p_callbacks,
        p_hung_ups, p_others, p_wrong, v_comments),
      edited_at = now()
  where id = p_message;
end;
$$;

alter function public.update_shift_report(uuid, int, int, int, int, int, int, text) owner to postgres;
revoke all on function public.update_shift_report(uuid, int, int, int, int, int, int, text) from public, anon;
grant execute on function public.update_shift_report(uuid, int, int, int, int, int, int, text) to authenticated;

-- ------------------------------------------------------------
-- One report's stored values, to fill the form for an edit.
-- ------------------------------------------------------------
create or replace function public.shift_report_for_message(p_message uuid)
returns table (
  pick_ups int, appts int, callbacks int, hung_ups int, others int,
  wrong_numbers int, comments text
)
language sql stable security definer
set search_path = public
as $$
  select r.pick_ups, r.appts, r.callbacks, r.hung_ups, r.others,
         r.wrong_numbers, r.comments
  from shift_reports r
  join messages m on m.id = r.message_id and m.deleted_at is null
  where r.message_id = p_message
    and private.can_edit_form_post(r.room_id, r.created_by)
$$;

alter function public.shift_report_for_message(uuid) owner to postgres;
revoke all on function public.shift_report_for_message(uuid) from public, anon;
grant execute on function public.shift_report_for_message(uuid) to authenticated;

-- ------------------------------------------------------------
-- Totals per person over shift days p_from..p_to. Everyone in the group
-- is listed (a 0 shows who has not reported); a dialer sees only their own
-- line, admins and managers everyone's — as in the group itself.
-- ------------------------------------------------------------
create or replace function public.shift_report_totals_range(
  p_room uuid,
  p_from date,
  p_to   date
)
returns table (
  user_id       uuid,
  person        text,
  reports       bigint,
  pick_ups      bigint,
  appts         bigint,
  callbacks     bigint,
  hung_ups      bigint,
  others        bigint,
  wrong_numbers bigint,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  with per as (
    select r.created_by,
           count(*) as reports,
           sum(r.pick_ups) as pick_ups, sum(r.appts) as appts,
           sum(r.callbacks) as callbacks, sum(r.hung_ups) as hung_ups,
           sum(r.others) as others, sum(r.wrong_numbers) as wrong_numbers
    from public.shift_reports r
    join public.messages m on m.id = r.message_id and m.deleted_at is null
    where r.room_id = p_room
      and r.shift_day between p_from and p_to
    group by r.created_by
  ),
  people as (
    select rm.user_id from public.room_members rm where rm.room_id = p_room
    union
    select created_by from per
  )
  select
    pp.user_id,
    coalesce(nullif(btrim(p.public_name), ''), p.full_name),
    coalesce(per.reports, 0),
    coalesce(per.pick_ups, 0), coalesce(per.appts, 0),
    coalesce(per.callbacks, 0), coalesce(per.hung_ups, 0),
    coalesce(per.others, 0), coalesce(per.wrong_numbers, 0),
    p_from,
    p_to
  from people pp
  join public.profiles p on p.id = pp.user_id
  left join per on per.created_by = pp.user_id
  where p_from <= p_to
    and private.current_user_role() is not null
    and (private.current_user_role() = 'admin'
         or private.is_room_member(p_room, auth.uid()))
    and (private.drop_box_reviewer(auth.uid()) or pp.user_id = auth.uid())
  order by coalesce(per.reports, 0) desc, coalesce(per.pick_ups, 0) desc, 2 asc
$$;

alter function public.shift_report_totals_range(uuid, date, date) owner to postgres;
revoke all on function public.shift_report_totals_range(uuid, date, date) from public, anon;
grant execute on function public.shift_report_totals_range(uuid, date, date) to authenticated;

create or replace function public.shift_report_totals(
  p_room   uuid,
  p_period text default 'today'
)
returns table (
  user_id       uuid,
  person        text,
  reports       bigint,
  pick_ups      bigint,
  appts         bigint,
  callbacks     bigint,
  hung_ups      bigint,
  others        bigint,
  wrong_numbers bigint,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  select * from public.shift_report_totals_range(
    p_room, private.period_start(p_period), private.shift_day(now()))
$$;

alter function public.shift_report_totals(uuid, text) owner to postgres;
revoke all on function public.shift_report_totals(uuid, text) from public, anon;
grant execute on function public.shift_report_totals(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- The export's rows over shift days p_from..p_to.
-- ------------------------------------------------------------
create or replace function public.shift_reports_export_range(
  p_room uuid,
  p_from date,
  p_to   date
)
returns table (
  shift_day     date,
  dialer_name   text,
  pick_ups      int,
  appts         int,
  callbacks     int,
  hung_ups      int,
  others        int,
  wrong_numbers int,
  comments      text,
  created_at    timestamptz,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  select
    r.shift_day, r.dialer_name, r.pick_ups, r.appts, r.callbacks, r.hung_ups,
    r.others, r.wrong_numbers, r.comments, r.created_at, p_from, p_to
  from public.shift_reports r
  join public.messages m on m.id = r.message_id and m.deleted_at is null
  where r.room_id = p_room
    and r.shift_day between p_from and p_to
    and private.current_user_role() is not null
    and (private.current_user_role() = 'admin'
         or private.is_room_member(p_room, auth.uid()))
    and (r.created_by = auth.uid() or private.drop_box_reviewer(auth.uid()))
  order by r.shift_day, r.created_at
$$;

alter function public.shift_reports_export_range(uuid, date, date) owner to postgres;
revoke all on function public.shift_reports_export_range(uuid, date, date) from public, anon;
grant execute on function public.shift_reports_export_range(uuid, date, date) to authenticated;

create or replace function public.shift_reports_export(
  p_room   uuid,
  p_period text default 'today'
)
returns table (
  shift_day     date,
  dialer_name   text,
  pick_ups      int,
  appts         int,
  callbacks     int,
  hung_ups      int,
  others        int,
  wrong_numbers int,
  comments      text,
  created_at    timestamptz,
  from_day      date,
  to_day        date
)
language sql stable security definer
set search_path = public
as $$
  select * from public.shift_reports_export_range(
    p_room, private.period_start(p_period), private.shift_day(now()))
$$;

alter function public.shift_reports_export(uuid, text) owner to postgres;
revoke all on function public.shift_reports_export(uuid, text) from public, anon;
grant execute on function public.shift_reports_export(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- Appointments: the stored values for an edit, and the edit itself.
-- ------------------------------------------------------------
create or replace function public.appointment_for_message(p_message uuid)
returns table (
  agent_name text, policy_number text, client_name text, phone text,
  appt_date date, appt_time time, appt_tz text, dialer_name text
)
language sql stable security definer
set search_path = public
as $$
  select a.agent_name, a.policy_number, a.client_name, a.phone,
         a.appt_date, a.appt_time, a.appt_tz, a.dialer_name
  from appointments a
  join messages m on m.id = a.message_id and m.deleted_at is null
  where a.message_id = p_message
    and private.can_edit_form_post(a.room_id, a.created_by)
$$;

alter function public.appointment_for_message(uuid) owner to postgres;
revoke all on function public.appointment_for_message(uuid) from public, anon;
grant execute on function public.appointment_for_message(uuid) to authenticated;

-- The dialer and the shift stay as booked. The agent must be on the list
-- (0025) — except that an agent since taken off the list may be kept.
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
  where id = v_appt.id;

  -- Same text as create_appointment (0025).
  update messages
  set body = '📅 Appointment' || E'\n'
        || 'Dialer: ' || v_appt.dialer_name || E'\n'
        || 'Agent: ' || v_agent || E'\n'
        || 'Policy #: ' || coalesce(v_policy, '—') || E'\n'
        || 'Client: ' || v_client || E'\n'
        || 'Phone: ' || v_phone || E'\n'
        || 'When: ' || to_char(p_date, 'Dy, Mon FMDD, YYYY') || ' · '
        || to_char(p_time, 'FMHH12:MI AM')
        || coalesce(' ' || v_tz, ''),
      edited_at = now()
  where id = p_message;
end;
$$;

alter function public.update_appointment(uuid, text, text, text, text, date, time, text) owner to postgres;
revoke all on function public.update_appointment(uuid, text, text, text, text, date, time, text) from public, anon;
grant execute on function public.update_appointment(uuid, text, text, text, text, date, time, text) to authenticated;

-- ------------------------------------------------------------
-- edit_message (0009): a form post is edited with its form only.
-- ------------------------------------------------------------
create or replace function public.edit_message(p_id uuid, p_body text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := private.assert_staff();
  v_msg messages%rowtype;
begin
  select * into v_msg from messages where id = p_id;
  if not found then raise exception 'message not found'; end if;
  if v_msg.deleted_at is not null then raise exception 'message was deleted'; end if;
  if v_msg.kind <> 'text' then raise exception 'only text messages can be edited'; end if;
  if v_msg.sender_id is distinct from v_actor then
    raise exception 'you can only edit your own messages' using errcode = '42501';
  end if;
  if coalesce(v_msg.metadata->>'event', '') in ('appointment', 'report') then
    raise exception 'edit it with its form' using errcode = '22023';
  end if;
  if coalesce(trim(p_body), '') = '' then
    raise exception 'message cannot be empty';
  end if;

  update messages set body = trim(p_body), edited_at = now() where id = p_id;
end;
$$;

-- ------------------------------------------------------------
-- Emoji reactions.
--
-- Stored on the message itself, as {"👍": [user ids…], …}, so they ride the
-- messages UPDATE stream every open chat already listens to (edits, pins)
-- and arrive with every message fetch — no second subscription. One fixed
-- set of emoji. Changed only through toggle_reaction, which locks the row,
-- so two people reacting at once cannot overwrite each other.
-- ------------------------------------------------------------
alter table public.messages
  add column if not exists reactions jsonb;

-- Can p_user read this message? The messages_select policy (0020), as a
-- function, for a security-definer caller.
create or replace function private.can_see_message(p_msg public.messages, p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = p_user and is_active)
     and (
       exists (select 1 from public.profiles where id = p_user and is_active and role = 'admin')
       or exists (
         select 1 from public.room_members rm
         where rm.room_id = p_msg.room_id
           and rm.user_id = p_user
           and (rm.can_view_history_from is null
                or p_msg.created_at >= rm.can_view_history_from)
           and (
             not private.room_own_messages_only(p_msg.room_id)
             or p_msg.sender_id = p_user
             or p_msg.sender_id is null
             or private.drop_box_reviewer(p_user)
           )
       )
     )
$$;

alter function private.can_see_message(public.messages, uuid) owner to postgres;

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
  if p_emoji is null or p_emoji not in ('👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅') then
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
