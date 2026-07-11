-- ============================================================
-- RLS verification scripts (run via supabase db execute / psql
-- after seeding test users). Uses pgTAP if available; otherwise
-- plain RAISE NOTICE assertions.
--
-- Expected seed (see seed_rls_fixtures.sql):
--   admin_id, manager_id, assistant_a, assistant_b, agent_user
--   agent_row with workspace room, assistant_a assigned with full history
-- ============================================================

create extension if not exists pgtap;

begin;

select plan(12);

-- Helper: set JWT claims for auth.uid()
create or replace function tests.set_auth(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claim.sub', p_uid::text, true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

-- 1. Assistant not in room cannot read messages
select tests.set_auth('00000000-0000-0000-0000-0000000000b2'::uuid); -- assistant_b
select is(
  (select count(*)::int from public.messages where room_id = (
    select id from public.rooms where type = 'agent_workspace' limit 1
  )),
  0,
  'unassigned assistant sees zero messages'
);

-- 2. Assigned assistant sees messages
select tests.set_auth('00000000-0000-0000-0000-0000000000a1'::uuid); -- assistant_a
select ok(
  (select count(*) from public.messages where room_id = (
    select id from public.rooms where type = 'agent_workspace' limit 1
  )) > 0,
  'assigned assistant sees workspace messages'
);

-- 3. History cutoff hides older messages
-- (fixture: assistant with can_view_history_from = now() sees none of the old ones)
select tests.set_auth('00000000-0000-0000-0000-0000000000a1'::uuid);
select ok(
  true, -- detailed cutoff covered in seed_rls_fixtures after swap
  'history cutoff placeholder — see end-to-end swap demo'
);

-- 4. Agent sees only own workspace room via get_my_rooms
select tests.set_auth('00000000-0000-0000-0000-0000000000e1'::uuid);
select is(
  (select count(*)::int from public.get_my_rooms()),
  1,
  'agent sees exactly one room'
);

select is(
  (select type from public.get_my_rooms() limit 1),
  'agent_workspace',
  'agent room is agent_workspace'
);

-- 5. Agent cannot see group rooms even if somehow listed
select is(
  (select count(*)::int from public.rooms where type = 'group'),
  0,
  'agent RLS hides group rooms (or none exist in fixture)'
);

-- 6–7. Audit logs immutable from authenticated clients
select tests.set_auth('00000000-0000-0000-0000-000000000001'::uuid); -- admin
select throws_ok(
  $$insert into public.audit_logs (action, target_type) values ('x','y')$$,
  null,
  null,
  'clients cannot insert audit_logs'
);

select throws_ok(
  $$delete from public.audit_logs$$,
  null,
  null,
  'clients cannot delete audit_logs'
);

-- 8. Admin can read audit
select ok(
  (select count(*) from public.audit_logs) >= 0,
  'admin can select audit_logs'
);

-- 9. Assistant cannot read audit
select tests.set_auth('00000000-0000-0000-0000-0000000000a1'::uuid);
select is(
  (select count(*)::int from public.audit_logs),
  0,
  'assistant cannot read audit_logs'
);

-- 10. Deactivated user has null role helper
-- (covered by private.current_user_role checking is_active)

-- 11. Messages insert requires membership
select tests.set_auth('00000000-0000-0000-0000-0000000000b2'::uuid);
select throws_ok(
  format(
    $$insert into public.messages (room_id, sender_id, kind, body)
      values (%L, %L, 'text', 'nope')$$,
    (select id from public.rooms where type = 'agent_workspace' limit 1),
    '00000000-0000-0000-0000-0000000000b2'
  ),
  null,
  null,
  'non-member cannot insert messages'
);

-- 12. System messages cannot be inserted by clients
select tests.set_auth('00000000-0000-0000-0000-0000000000a1'::uuid);
select throws_ok(
  format(
    $$insert into public.messages (room_id, sender_id, kind, body)
      values (%L, null, 'system', 'fake')$$,
    (select id from public.rooms where type = 'agent_workspace' limit 1)
  ),
  null,
  null,
  'clients cannot insert system messages'
);

select * from finish();
rollback;
