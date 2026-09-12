-- ============================================================
-- 0014_search.sql — make message search indexable
--
-- Global search matches SUBSTRINGS (people search for "invoic", "+355",
-- part of a filename), so this uses trigrams rather than full-text
-- search: to_tsvector would impose stemming and a language choice, and
-- this team writes Albanian and English in the same conversation.
--
-- A GIN trigram index is what lets `body ILIKE '%term%'` use an index
-- instead of scanning. At today's volume (~2k messages) a plain scan is
-- already instant — this is insurance so search keeps up as the history
-- grows, and it is far cheaper to add now than to index a large table
-- later.
--
-- No new read path or permission surface: search runs as the signed-in
-- user against public.messages, so the existing messages_select policy
-- (membership + each member's can_view_history_from cutoff + the admin
-- override) is what decides which rows can match. Nothing here widens it.
-- ============================================================

create extension if not exists pg_trgm;

create index if not exists messages_body_trgm_idx
  on public.messages using gin (body gin_trgm_ops);

-- Searching people by name benefits from the same treatment.
create index if not exists profiles_full_name_trgm_idx
  on public.profiles using gin (full_name gin_trgm_ops);
