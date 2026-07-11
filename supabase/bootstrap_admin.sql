-- ============================================================
-- Bootstrap the first admin after creating an Auth user in the
-- Supabase dashboard (Authentication > Users > Add user).
--
-- 1. Create user with email/password in dashboard
-- 2. Copy their UUID
-- 3. Replace the placeholders below and run in SQL editor
-- ============================================================

-- replace these:
--   'ADMIN_USER_UUID'
--   'Admin Name'

insert into public.profiles (id, full_name, role, is_active)
values (
  'ADMIN_USER_UUID'::uuid,
  'Admin Name',
  'admin',
  true
)
on conflict (id) do update
  set full_name = excluded.full_name,
      role = 'admin',
      is_active = true;
