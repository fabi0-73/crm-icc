/**
 * Accounts are plain usernames; Supabase auth still wants an email, so every
 * username maps to <name>@USERNAME_DOMAIN. Those mailboxes do not exist —
 * nothing may ever depend on email delivery (invites, resets). Admins hand
 * out passwords directly instead.
 */
export const USERNAME_DOMAIN = "iccdesk.duckdns.org";

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;

export const USERNAME_HINT =
  "2–32 characters: lowercase letters, numbers, dots or dashes.";

export function isValidUsername(username: string) {
  return username.length >= 2 && USERNAME_RE.test(username);
}

/** Auth Admin errors, rephrased for the admin doing the clicking. */
export function friendlyAuthError(
  message: string | undefined,
  fallback: string,
) {
  if (!message) return fallback;
  if (message.includes("already been registered")) {
    return "That username is already taken.";
  }
  if (message.includes("SUPABASE_SERVICE_ROLE_KEY")) {
    return "Server is missing its service key — check .env.local on the server.";
  }
  return message;
}

export function usernameToEmail(identifier: string) {
  return identifier.includes("@")
    ? identifier
    : `${identifier}@${USERNAME_DOMAIN}`;
}

/** Show the bare username for mapped accounts, the full email otherwise. */
export function emailToUsername(email: string) {
  const suffix = `@${USERNAME_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}

/* No ambiguous characters (0/o, 1/l/i) — these get read out loud. */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Readable throwaway password, e.g. "k7mp3-x9dqe". Meant to be changed. */
export function generatePassword() {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  const chars = Array.from(
    bytes,
    (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length],
  );
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}
