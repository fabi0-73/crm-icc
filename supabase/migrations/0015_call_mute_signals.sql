-- Mute/unmute is a first-class call signal so every participant's UI
-- can update immediately, and so a host can mute someone else's mic.
alter table public.call_signals drop constraint if exists call_signals_kind_check;
alter table public.call_signals
  add constraint call_signals_kind_check
  check (
    kind in (
      'invite',
      'offer',
      'answer',
      'ice',
      'hangup',
      'decline',
      'mute'
    )
  );
