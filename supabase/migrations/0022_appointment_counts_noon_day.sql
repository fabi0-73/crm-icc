-- ============================================================
-- 0022 — count APPOINTMENTS, on a shift day that turns over at noon
-- ============================================================
-- Two corrections to 0021, both found by looking at the actual messages.
--
-- 1. THE DAY. Posting in this group runs 15:00 to 06:00 Tirane time — a US
--    call centre working American evenings — so a calendar day splits every
--    shift in half. Not one message in 2,042 was ever posted between 07:00
--    and 14:00, so noon is a boundary nothing can land on. A shift day is
--    therefore 12:00 to 12:00, labelled by the date it began: subtract
--    twelve hours, then take the date.
--
-- 2. WHAT IS COUNTED. 0021 counted every message, but only about 725 of
--    2,042 are appointment records — the rest is conversation ("bravo",
--    "jo", replies, mentions). Counting all of them overstated the real
--    figure roughly threefold.
--
-- The ranges are computed HERE rather than in the browser, so a phone set
-- to the wrong timezone cannot shift someone's numbers.

-- ------------------------------------------------------------
-- What an appointment record looks like.
--
-- Agents write these in several styles — "client time", "Client's time",
-- bare "mst/est", or code columns like "OTS | AWS" — so no single phrase
-- identifies one. What they all carry is a client's PHONE NUMBER together
-- with either a DATE or a policy reference. Conversation almost never has
-- both, which is what makes this separable at all.
--
-- It is a pattern, not a certainty. Kept in one function so the rule can be
-- tightened in one place as the writing style changes.
-- ------------------------------------------------------------
create or replace function private.looks_like_appointment(p_body text)
returns boolean
language sql immutable
as $$
  select
    coalesce(p_body, '') ~ '[0-9]{3}[^0-9]{0,2}[0-9]{3}[^0-9]{0,2}[0-9]{4}'
    and (
      coalesce(p_body, '') ~ '[0-9]{1,2}/[0-9]{1,2}'
      or coalesce(p_body, '') ~* 'polic'
      or coalesce(p_body, '') ~* '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)'
    )
    -- An end-of-shift tally ("pickup-4 | app-2") is a summary, not a record.
    and coalesce(p_body, '') !~* 'pick ?-? ?up *-? *[0-9]'
$$;

alter function private.looks_like_appointment(text) owner to postgres;

-- ------------------------------------------------------------
-- The shift day a moment belongs to: 12:00 Tirane starts a new one.
-- ------------------------------------------------------------
create or replace function private.shift_day(p_at timestamptz)
returns date
language sql immutable
as $$
  select (((p_at at time zone 'Europe/Tirane') - interval '12 hours'))::date
$$;

alter function private.shift_day(timestamptz) owner to postgres;

-- ------------------------------------------------------------
-- Counts per person for a named period. Replaces the (uuid, date, date)
-- form from 0021 — the browser no longer picks the dates.
-- ------------------------------------------------------------
drop function if exists public.room_post_counts(uuid, date, date);

create function public.room_post_counts(
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
  with bounds as (
    select
      case p_period
        when 'today' then private.shift_day(now())
        when 'week'  then (date_trunc('week',  private.shift_day(now()))::date)
        when 'month' then (date_trunc('month', private.shift_day(now()))::date)
        else '2000-01-01'::date
      end as d_from,
      private.shift_day(now()) as d_to
  )
  select
    rm.user_id,
    coalesce(nullif(btrim(p.public_name), ''), p.full_name) as person,
    count(*) filter (where private.looks_like_appointment(m.body)) as appointments,
    count(*) filter (where m.id is not null
                       and not private.looks_like_appointment(m.body)) as other_posts,
    b.d_from,
    b.d_to
  from public.room_members rm
  join public.profiles p on p.id = rm.user_id
  cross join bounds b
  left join public.messages m
    on m.room_id = rm.room_id
   and m.sender_id = rm.user_id
   and private.shift_day(m.created_at) between b.d_from and b.d_to
  where rm.room_id = p_room
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
      or rm.user_id = auth.uid()
    )
  group by rm.user_id, person, b.d_from, b.d_to
  order by appointments desc, other_posts desc, person asc
$$;

revoke execute on function public.room_post_counts(uuid, text) from public, anon;
grant execute on function public.room_post_counts(uuid, text) to authenticated;
