-- ============================================================
-- 0025 — the agents an appointment can be booked with, as a list
-- ============================================================
-- The form's Agent field was free text, so one agent appeared under several
-- spellings ("Sami Alkhalil" / "sami alkhalil" / "Sami Alkalil", "Nick
-- Keeley" / "NICK KEEELEY") and the Excel totals split. Now the dialer picks
-- from a list that admins and managers keep. Only ~3 of the ~35 agents used
-- have CRM logins, so this is its own list, not the agents table.
--
-- The table has RLS on and no policies: every read and change goes through
-- the functions below, which check the caller's role.

create table if not exists public.appointment_agents (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 200),
  active     boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create unique index if not exists appointment_agents_name_key
  on public.appointment_agents (lower(btrim(name)));

alter table public.appointment_agents enable row level security;
revoke all on public.appointment_agents from anon, authenticated;

-- ------------------------------------------------------------
-- The list, for anyone signed in (the form needs it).
-- ------------------------------------------------------------
create or replace function public.appointment_agent_names()
returns table (id uuid, name text)
language sql stable security definer
set search_path = public
as $$
  select a.id, a.name
  from public.appointment_agents a
  where a.active
    and private.current_user_role() is not null
  order by lower(a.name)
$$;

alter function public.appointment_agent_names() owner to postgres;
revoke all on function public.appointment_agent_names() from public, anon;
grant execute on function public.appointment_agent_names() to authenticated;

-- ------------------------------------------------------------
-- Add a name (admins and managers). Adding a name already on the list
-- changes nothing; a name removed earlier comes back.
-- ------------------------------------------------------------
create or replace function public.add_appointment_agent(p_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id   uuid;
begin
  if private.current_user_role() is distinct from 'admin'
     and private.current_user_role() is distinct from 'manager' then
    raise exception 'only admins and managers can change the agent list'
      using errcode = '42501';
  end if;
  if v_name = '' or length(v_name) > 200 then
    raise exception 'enter a name (up to 200 characters)' using errcode = '22023';
  end if;

  select a.id into v_id from appointment_agents a
  where lower(btrim(a.name)) = lower(v_name);
  if v_id is not null then
    -- Already listed: keep its spelling. Removed earlier: back, as typed now.
    update appointment_agents
    set name = case when active then name else v_name end, active = true
    where id = v_id;
    return v_id;
  end if;

  insert into appointment_agents (name, created_by)
  values (v_name, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

alter function public.add_appointment_agent(text) owner to postgres;
revoke all on function public.add_appointment_agent(text) from public, anon;
grant execute on function public.add_appointment_agent(text) to authenticated;

-- ------------------------------------------------------------
-- Take a name off the list (admins and managers). Kept, only hidden:
-- appointments already booked with it are untouched.
-- ------------------------------------------------------------
create or replace function public.remove_appointment_agent(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if private.current_user_role() is distinct from 'admin'
     and private.current_user_role() is distinct from 'manager' then
    raise exception 'only admins and managers can change the agent list'
      using errcode = '42501';
  end if;
  update appointment_agents set active = false where id = p_id;
end;
$$;

alter function public.remove_appointment_agent(uuid) owner to postgres;
revoke all on function public.remove_appointment_agent(uuid) from public, anon;
grant execute on function public.remove_appointment_agent(uuid) to authenticated;

-- ------------------------------------------------------------
-- The starting list: the agents used so far, one spelling each. Merged:
-- case variants, "Sami Alkalil" and "NICK KEEELEY" (typos), "Kianna" →
-- Kiana, and a first name alone where exactly one full name matches it
-- (Eda, Gjon, Imaad, Melissa, Sebastian, John). Left out as ambiguous:
-- "Anthony" (Recker or Ruggiero) and "Nick" (Keeley or Mccalla).
-- ------------------------------------------------------------
insert into public.appointment_agents (name) values
  ('Alex Gamboa'), ('Alexander Dubra'), ('Anthony Recker'),
  ('Anthony Ruggiero'), ('Ardian'), ('Brandon Stewart'), ('Clara Russell'),
  ('Devon Conway'), ('Dominic Gappy'), ('Drew Hall'), ('Dylan Torello'),
  ('Eda Petuqi'), ('Franko'), ('Gjon Lulgjuraj'), ('Imaad Jalloh'),
  ('JaMario'), ('Jamee Lamers'), ('Jesse Caver'), ('John Avila'),
  ('Keeneth'), ('Kiana'), ('Lance'), ('Melissa Grieb'), ('Miguel Quinones'),
  ('Nicholas Mccalla'), ('Nick Keeley'), ('Nikolla Lulgjuraj'), ('Roben'),
  ('Sami Alkhalil'), ('Sebastian Quinterro'), ('Seven'), ('Sydney'),
  ('Tucker Paynter'), ('Ty Morrow')
on conflict do nothing;

-- ------------------------------------------------------------
-- create_appointment (0024) — the agent must be on the list, and is stored
-- with the list's spelling.
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
  v_agent   text;
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

notify pgrst, 'reload schema';
