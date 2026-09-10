/** Chat-facing name. Falls back to the internal full name. */
export function publicDisplayName(person: {
  full_name: string;
  public_name?: string | null;
}) {
  const n = person.public_name?.trim();
  return n || person.full_name;
}
