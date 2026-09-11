/**
 * URL detection for media history. Links are not stored separately — they
 * are extracted from message bodies on read, so history written before this
 * feature existed is covered too.
 */

/** http(s) only — bare "www." guessing produces false positives in prose. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Trailing punctuation that commonly abuts a URL written in a sentence. */
const TRAILING = /[),.;:!?\]}]$/;

const COUNT = (s: string, ch: string) =>
  s.split(ch).length - 1;

/**
 * Strip sentence punctuation stuck to the end of a URL — but keep a closing
 * bracket that actually belongs to the URL, so links like
 * ".../wiki/Foo_(bar)" survive intact.
 */
function trimTrailing(raw: string): string {
  let s = raw;
  for (;;) {
    const m = s.match(TRAILING);
    if (!m) break;
    const ch = m[0];
    if (ch === ")" && COUNT(s, ")") <= COUNT(s, "(")) break;
    if (ch === "]" && COUNT(s, "]") <= COUNT(s, "[")) break;
    if (ch === "}" && COUNT(s, "}") <= COUNT(s, "{")) break;
    s = s.slice(0, -1);
  }
  return s;
}

export function extractLinks(
  body: string | null | undefined,
  cap = 10,
): string[] {
  if (!body) return [];
  const found = body.match(URL_RE);
  if (!found) return [];
  const out: string[] = [];
  for (const raw of found) {
    const cleaned = trimTrailing(raw);
    if (!cleaned) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
    if (out.length >= cap) break;
  }
  return out;
}

/** Hostname without "www." — the label shown on a link row. */
export function linkDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
