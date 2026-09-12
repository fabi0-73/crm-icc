import { extractLinks } from "@/lib/media/links";

/**
 * Message body rendering: light formatting, @mentions and clickable links.
 *
 * Deliberately a small hand-rolled renderer producing React nodes rather than
 * a markdown library writing HTML. Message bodies are untrusted user input,
 * so nothing here ever touches dangerouslySetInnerHTML — the worst a hostile
 * body can do is render as text.
 *
 * Supported, chosen to match what people already type in chat:
 *   **bold**    *italic*    __underline__
 *   - bullet  (also "* bullet")
 *   1. numbered
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest-delimiter-first so "**bold**" wins over "*italic*". */
const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;

type Opts = {
  /** Display names to highlight as mentions ("@Full Name"). */
  mentionNames: string[];
  /** Own bubbles are dark, so links/mentions need light styling. */
  mine: boolean;
};

/** Innermost layer: bare URLs become anchors. */
function withLinks(text: string, key: string, opts: Opts): React.ReactElement[] {
  const urls = extractLinks(text, 20);
  if (urls.length === 0) return [<span key={`${key}only`}>{text}</span>];
  const ordered = Array.from(new Set(urls)).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${ordered.map(escapeRegExp).join("|")})`, "g");
  return text.split(re).map((part, i) =>
    ordered.includes(part) ? (
      <a
        key={`${key}a${i}`}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={
          opts.mine
            ? "underline decoration-white/60 underline-offset-2 hover:decoration-white"
            : "text-brand-700 underline underline-offset-2 hover:text-brand-800"
        }
      >
        {part}
      </a>
    ) : (
      <span key={`${key}t${i}`}>{part}</span>
    ),
  );
}

/** Middle layer: @mentions, then links inside the remaining text. */
function withMentions(text: string, key: string, opts: Opts): React.ReactElement[] {
  if (opts.mentionNames.length === 0) return withLinks(text, key, opts);
  const unique = Array.from(new Set(opts.mentionNames)).sort(
    (a, b) => b.length - a.length,
  );
  const re = new RegExp(
    `(${unique.map((n) => `@${escapeRegExp(n)}`).join("|")})`,
    "g",
  );
  return text.split(re).flatMap<React.ReactElement>((part, i) => {
    if (i % 2 === 1) {
      return [
        <span
          key={`${key}m${i}`}
          className={
            opts.mine
              ? "font-semibold underline decoration-white/40 underline-offset-2"
              : "font-semibold text-brand-700"
          }
        >
          {part}
        </span>,
      ];
    }
    return withLinks(part, `${key}p${i}`, opts);
  });
}

/** Outer inline layer: bold / italic / underline runs. */
function withFormatting(text: string, key: string, opts: Opts): React.ReactElement[] {
  return text.split(INLINE_RE).flatMap<React.ReactElement>((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return [<strong key={`${key}b${i}`}>{part.slice(2, -2)}</strong>];
    }
    if (part.startsWith("__") && part.endsWith("__") && part.length > 4) {
      return [<u key={`${key}u${i}`}>{part.slice(2, -2)}</u>];
    }
    if (
      (part.startsWith("*") && part.endsWith("*") && part.length > 2) ||
      (part.startsWith("_") && part.endsWith("_") && part.length > 2)
    ) {
      return [<em key={`${key}i${i}`}>{part.slice(1, -1)}</em>];
    }
    return withMentions(part, `${key}f${i}`, opts);
  });
}

/**
 * Render a message body. Consecutive "- " / "1. " lines collapse into real
 * lists; everything else keeps its original line breaks (the bubble uses
 * whitespace-pre-wrap), so formatting never reflows someone's message.
 */
export function renderRichText(body: string, opts: Opts): React.ReactNode {
  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join("\n");
    blocks.push(
      <span key={`p${blocks.length}`} className="whitespace-pre-wrap">
        {withFormatting(text, `p${blocks.length}`, opts)}
      </span>,
    );
    para = [];
  };

  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    const Tag = ordered ? "ol" : "ul";
    blocks.push(
      <Tag
        key={`l${blocks.length}`}
        className={`my-1 space-y-0.5 pl-5 ${
          ordered ? "list-decimal" : "list-disc"
        }`}
      >
        {items.map((item, i) => (
          <li key={i}>{withFormatting(item, `l${blocks.length}i${i}`, opts)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  for (const line of lines) {
    const bullet = BULLET_RE.exec(line);
    const numbered = !bullet ? NUMBERED_RE.exec(line) : null;

    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const item = (bullet?.[1] ?? numbered?.[1] ?? "").trim();
      flushPara();
      // A switch between bullets and numbers starts a new list.
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item);
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return blocks.length === 1 ? blocks[0] : blocks;
}
