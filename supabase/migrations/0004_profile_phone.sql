-- Optional phone numbers for click-to-call (tel: links).
alter table public.profiles
  add column if not exists phone text;
