-- Row-count parity between the cloud project and the self-hosted stack.
-- Run against both; the numbers must match before cutover.
--
-- storage.objects is included deliberately: those rows are recreated by
-- the Storage API when files are copied over S3, so a mismatch here means
-- the file copy is incomplete even though the database restore succeeded.
select 'auth.users'       as what, count(*) as rows from auth.users
union all select 'auth.identities',   count(*) from auth.identities
union all select 'profiles',          count(*) from public.profiles
union all select 'agents',            count(*) from public.agents
union all select 'assignments',       count(*) from public.assignments
union all select 'rooms',             count(*) from public.rooms
union all select 'room_members',      count(*) from public.room_members
union all select 'messages',          count(*) from public.messages
union all select 'audit_logs',        count(*) from public.audit_logs
union all select 'storage.objects',   count(*) from storage.objects where bucket_id = 'attachments'
order by what;
