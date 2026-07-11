-- 0006_active_user_select.sql — deactivation locks reads instantly.
--
-- Before this, SELECT policies checked room membership only, so a
-- deactivated user with a still-valid access token (up to ~1h; refresh
-- is blocked by the auth ban) kept reading messages and receiving
-- realtime inserts. private.current_user_role() returns NULL for
-- missing/deactivated users, so requiring it non-null everywhere makes
-- deactivation take effect on the next query / realtime event.
--
-- profiles_select keeps its `id = auth.uid()` clause untouched so a
-- deactivated user's client can still read its own profile and route
-- to the signed-out state.

drop policy messages_select on public.messages;
create policy messages_select on public.messages for select using (
  private.current_user_role() is not null
  and exists (
    select 1 from public.room_members rm
    where rm.room_id = messages.room_id
      and rm.user_id = auth.uid()
      and (rm.can_view_history_from is null
           or messages.created_at >= rm.can_view_history_from)
  )
);

drop policy rooms_select on public.rooms;
create policy rooms_select on public.rooms for select using (
  private.current_user_role() is not null
  and (
    private.is_room_member(id, auth.uid())
    or private.current_user_role() in ('admin', 'manager')
  )
);

drop policy room_members_select on public.room_members;
create policy room_members_select on public.room_members for select using (
  private.current_user_role() is not null
  and (
    private.is_room_member(room_id, auth.uid())
    or private.current_user_role() in ('admin', 'manager')
  )
);

drop policy agents_select on public.agents;
create policy agents_select on public.agents for select using (
  private.current_user_role() is not null
  and (
    private.current_user_role() in ('admin', 'manager')
    or user_id = auth.uid()
    or exists (
      select 1 from public.assignments a
      where a.agent_id = agents.id
        and a.assistant_id = auth.uid()
        and a.removed_at is null
    )
  )
);

drop policy assignments_select on public.assignments;
create policy assignments_select on public.assignments for select using (
  private.current_user_role() is not null
  and (
    private.current_user_role() in ('admin', 'manager')
    or assistant_id = auth.uid()
  )
);

drop policy call_signals_select on public.call_signals;
create policy call_signals_select on public.call_signals
  for select to authenticated
  using (
    private.current_user_role() is not null
    and auth.uid() in (from_user, to_user)
  );

drop policy attachments_select on storage.objects;
create policy attachments_select on storage.objects for select using (
  bucket_id = 'attachments'
  and private.current_user_role() is not null
  and (
    owner = auth.uid()
    or private.can_access_attachment(name, auth.uid())
  )
);
