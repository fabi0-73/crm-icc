-- ============================================================
-- 0029 — dialer idle: assistants report away after no input;
--        only admins can see it
-- ============================================================
-- An assistant (a dialer) reports whether their CRM session has gone
-- 5 minutes without mouse or keyboard input. Admins are the only role
-- that can read those rows, so the dialer, managers, and agents never
-- see the notice. The client decides when the 5 minutes have passed;
-- this table only stores the transition.

create table if not exists public.dialer_activity (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  away       boolean not null,
  changed_at timestamptz not null default now()
);

alter table public.dialer_activity owner to postgres;
alter table public.dialer_activity enable row level security;
revoke all on public.dialer_activity from anon, authenticated;
grant select on public.dialer_activity to authenticated;

create policy dialer_activity_admin_select on public.dialer_activity
  for select to authenticated
  using (private.current_user_role() = 'admin');

-- Assistants only, and only their own row. A repeat of the same state
-- does not update, so realtime does not fire twice for one transition.
create or replace function public.report_dialer_activity(p_away boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or private.current_user_role() is distinct from 'assistant' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- An "active" report only clears an existing away row. Opening the app
  -- when nobody was watching does not insert a row or notify admins.
  if p_away then
    insert into public.dialer_activity (user_id, away, changed_at)
    values (v_me, true, now())
    on conflict (user_id) do update
      set away = true,
          changed_at = excluded.changed_at
      where public.dialer_activity.away is distinct from true;
  else
    update public.dialer_activity
      set away = false,
          changed_at = now()
      where user_id = v_me
        and away is distinct from false;
  end if;
end;
$$;

alter function public.report_dialer_activity(boolean) owner to postgres;
revoke all on function public.report_dialer_activity(boolean) from public, anon;
grant execute on function public.report_dialer_activity(boolean) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dialer_activity'
  ) then
    alter publication supabase_realtime add table public.dialer_activity;
  end if;
end $$;
