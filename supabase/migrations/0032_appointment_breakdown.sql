-- ============================================================
-- 0032 — appointments per dialer and agent, for the Counts tab filters
-- ============================================================
-- Admins and managers filter the Counts tab by agent and by dialer
-- ("how many did Sami's dialers book this week", "which agents did Aleks
-- book with"). Only form appointments name an agent, so this counts those
-- (every appointment since the form went live, 0023), with the same rule
-- as the main counts (0024): one appointment per client per shift, credited
-- to whoever posted it first. Deleted posts don't count.
--
-- Same visibility as the counts: a member of the group (or an admin); a
-- dialer gets only their own rows.

create or replace function public.appointment_breakdown_range(
  p_room uuid,
  p_from date,
  p_to   date
)
returns table (
  dialer_id    uuid,
  dialer_name  text,
  agent_name   text,
  appointments bigint,
  from_day     date,
  to_day       date
)
language sql stable security definer
set search_path = public
as $$
  with firsts as (
    select distinct on (
      a.shift_day,
      right(regexp_replace(a.phone, '[^0-9]', '', 'g'), 10)
        || '|' || a.appt_date::text || '|' || lower(btrim(a.client_name))
    )
      a.created_by, a.agent_name
    from public.appointments a
    join public.messages m on m.id = a.message_id and m.deleted_at is null
    where a.room_id = p_room
      and a.shift_day between p_from and p_to
    order by
      a.shift_day,
      right(regexp_replace(a.phone, '[^0-9]', '', 'g'), 10)
        || '|' || a.appt_date::text || '|' || lower(btrim(a.client_name)),
      a.created_at
  )
  select
    f.created_by,
    coalesce(nullif(btrim(p.public_name), ''), p.full_name),
    f.agent_name,
    count(*),
    p_from,
    p_to
  from firsts f
  join public.profiles p on p.id = f.created_by
  where p_from <= p_to
    and private.current_user_role() is not null
    and (private.current_user_role() = 'admin'
         or private.is_room_member(p_room, auth.uid()))
    and (private.drop_box_reviewer(auth.uid()) or f.created_by = auth.uid())
  group by f.created_by, p.public_name, p.full_name, f.agent_name
  order by count(*) desc, 2, 3
$$;

alter function public.appointment_breakdown_range(uuid, date, date) owner to postgres;
revoke all on function public.appointment_breakdown_range(uuid, date, date) from public, anon;
grant execute on function public.appointment_breakdown_range(uuid, date, date) to authenticated;

create or replace function public.appointment_breakdown(
  p_room   uuid,
  p_period text default 'today'
)
returns table (
  dialer_id    uuid,
  dialer_name  text,
  agent_name   text,
  appointments bigint,
  from_day     date,
  to_day       date
)
language sql stable security definer
set search_path = public
as $$
  select * from public.appointment_breakdown_range(
    p_room, private.period_start(p_period), private.shift_day(now()))
$$;

alter function public.appointment_breakdown(uuid, text) owner to postgres;
revoke all on function public.appointment_breakdown(uuid, text) from public, anon;
grant execute on function public.appointment_breakdown(uuid, text) to authenticated;

notify pgrst, 'reload schema';
