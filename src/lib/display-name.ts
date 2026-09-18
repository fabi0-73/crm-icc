/**
 * The name to show someone by in chats, calls and pickers: their public
 * name when they have set one (assistants and agents only), otherwise their
 * account name. Admin screens (Users, Agents, Audit) keep using full_name,
 * so the people who manage accounts always see who is really who.
 */
export function publicDisplayName(person: {
  full_name: string;
  public_name?: string | null;
}): string {
  return person.public_name?.trim() || person.full_name;
}

/** Case-insensitive match on either name — what a people search should hit. */
export function matchesName(
  person: { full_name: string; public_name?: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    person.full_name.toLowerCase().includes(q) ||
    Boolean(person.public_name?.toLowerCase().includes(q))
  );
}
