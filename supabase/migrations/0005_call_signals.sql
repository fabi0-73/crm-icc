-- Ephemeral WebRTC signaling (invite/offer/answer/ice). Chat realtime already works;
-- broadcast channels were unreliable for cross-device calls.

create table public.call_signals (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  call_id uuid not null,
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (
    kind in ('invite', 'offer', 'answer', 'ice', 'hangup', 'decline')
  ),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index call_signals_room_created_idx on public.call_signals (room_id, created_at desc);
create index call_signals_to_user_idx on public.call_signals (to_user, created_at desc);

alter table public.call_signals enable row level security;

create policy call_signals_select on public.call_signals
  for select to authenticated
  using (auth.uid() in (from_user, to_user));

create policy call_signals_insert on public.call_signals
  for insert to authenticated
  with check (
    from_user = auth.uid()
    and exists (
      select 1 from public.room_members rm
      where rm.room_id = call_signals.room_id
        and rm.user_id = auth.uid()
    )
    and exists (
      select 1 from public.room_members rm
      where rm.room_id = call_signals.room_id
        and rm.user_id = call_signals.to_user
    )
  );

-- Participants can delete their own call's rows (hangup cleanup)
create policy call_signals_delete on public.call_signals
  for delete to authenticated
  using (auth.uid() in (from_user, to_user));

alter publication supabase_realtime add table public.call_signals;
