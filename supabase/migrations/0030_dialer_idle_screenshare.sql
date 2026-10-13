-- ============================================================
-- 0030 — idle notices: anyone sharing can report; admins and
--        managers can read. The call screen decides who is shown.
-- ============================================================

drop policy if exists dialer_activity_admin_select on public.dialer_activity;

create policy dialer_activity_supervisor_select on public.dialer_activity
  for select to authenticated
  using (private.current_user_role() in ('admin', 'manager'));

create or replace function public.report_dialer_activity(p_away boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or private.current_user_role() is null then
    raise exception 'permission denied' using errcode = '42501';
  end if;

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
