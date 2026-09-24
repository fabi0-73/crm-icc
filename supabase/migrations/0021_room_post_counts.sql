-- ============================================================
-- 0021 — how many did each person post, over a period
-- ============================================================
-- The appointments group is a submission log: one message is one
-- appointment. At 277 posts a day, counting them by scrolling is the job
-- this replaces.
--
-- DAYS ARE LOCAL DAYS. The database runs in UTC and the business is at
-- UTC+2, so grouping on created_at::date would file everything booked
-- between midnight and 02:00 under the previous day — daily totals would
-- be quietly wrong every single night.
--
-- Every member is returned, including those who posted nothing: "who
-- booked zero this week" is the answer a supervisor most wants and the
-- one a plain GROUP BY silently omits.

create or replace function public.room_post_counts(
  p_room uuid,
  p_from date,
  p_to date
)
returns table (user_id uuid, person text, posts bigint)
language sql stable security definer
set search_path = public
as $$
  select
    rm.user_id,
    coalesce(nullif(btrim(p.public_name), ''), p.full_name) as person,
    count(m.id) as posts
  from public.room_members rm
  join public.profiles p on p.id = rm.user_id
  left join public.messages m
    on m.room_id = rm.room_id
   and m.sender_id = rm.user_id
   and (m.created_at at time zone 'Europe/Tirane')::date between p_from and p_to
  where rm.room_id = p_room
    and private.current_user_role() is not null
    -- The caller has to belong to the room (admins may look from outside,
    -- exactly as the message policy already lets them).
    and (
      exists (
        select 1 from public.room_members me
        where me.room_id = p_room and me.user_id = auth.uid()
      )
      or private.current_user_role() = 'admin'
    )
    -- Reviewers see the whole team; everyone else sees only their own line,
    -- which mirrors who may read the messages being counted.
    and (
      private.drop_box_reviewer(auth.uid())
      or rm.user_id = auth.uid()
    )
  group by 1, 2
  order by 3 desc, 2 asc
$$;

revoke execute on function public.room_post_counts(uuid, date, date) from public, anon;
grant execute on function public.room_post_counts(uuid, date, date) to authenticated;
