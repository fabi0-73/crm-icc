import type { ReactNode } from "react";

/** Hard cap on what a person can send in one message. */
export const MAX_MESSAGE_CHARS = 1000;

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]|www\.[^\s<>()]+[^\s<>().,!?;:'"])/gi;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBER_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/** Inline markers, longest first so __underline__ wins over _italic_. */
const INLINE_RULES: { re: RegExp; wrap: (children: ReactNode, key: string) => ReactNode }[] = [
  {
    re: /\*\*(.+?)\*\*/,
    wrap: (c, k) => <strong key={k} className="font-semibold">{c}</strong>,
  },
  {
    re: /__(.+?)__/,
    wrap: (c, k) => <u key={k}>{c}</u>,
  },
  {
    re: /(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/,
    wrap: (c, k) => <em key={k}>{c}</em>,
  },
  {
    re: /(?<![_\w])_(?!\s)(.+?)(?<!\s)_(?![_\w])/,
    wrap: (c, k) => <em key={k}>{c}</em>,
  },
];

function linkify(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const raw = match[0];
    const href = raw.startsWith("http") ? raw : `https://${raw}`;
    out.push(
      <a
        key={`${keyBase}-l${match.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline underline-offset-2 hover:opacity-80"
      >
        {raw}
      </a>,
    );
    last = match.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Apply the inline markers, then turn any remaining plain text into links. */
function inline(text: string, keyBase: string): ReactNode[] {
  for (const rule of INLINE_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    return [
      ...inline(before, `${keyBase}b`),
      rule.wrap(inline(m[1], `${keyBase}i`), `${keyBase}w`),
      ...inline(after, `${keyBase}a`),
    ];
  }
  return linkify(text, keyBase);
}

type Block =
  | { type: "p"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[]; start: number };

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const bullet = BULLET_RE.exec(line);
    const numbered = NUMBER_RE.exec(line);
    const tail = blocks[blocks.length - 1];

    if (bullet) {
      if (tail?.type === "ul") tail.items.push(bullet[1]);
      else blocks.push({ type: "ul", items: [bullet[1]] });
    } else if (numbered) {
      if (tail?.type === "ol") tail.items.push(numbered[2]);
      else
        blocks.push({
          type: "ol",
          items: [numbered[2]],
          start: Number(numbered[1]) || 1,
        });
    } else if (tail?.type === "p") {
      tail.lines.push(line);
    } else {
      blocks.push({ type: "p", lines: [line] });
    }
  }
  return blocks;
}

/**
 * Message body renderer: clickable URLs plus bold, italic, underline and
 * bulleted/numbered lists. Everything else stays literal text, and line
 * breaks are preserved exactly as they were typed.
 */
export function RichText({ text }: { text: string }) {
  const blocks = toBlocks(text);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === "ul") {
          return (
            <ul key={i} className="my-0.5 list-disc space-y-0.5 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, `${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol
              key={i}
              start={block.start}
              className="my-0.5 list-decimal space-y-0.5 pl-5"
            >
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, `${i}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && "\n"}
                {inline(line, `${i}-${j}`)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

/** Every URL in a message body, in the order they were typed. */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) found.push(match[0]);
  return found;
}

/** Plain-text preview (search results, notifications) with markers stripped. */
export function stripFormatting(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<![*\w])\*(.+?)\*(?![*\w])/g, "$1")
    .replace(/(?<![_\w])_(.+?)_(?![_\w])/g, "$1");
}
