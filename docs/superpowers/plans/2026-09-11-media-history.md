# Media History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-conversation media history panel (files + links) to group chats and DMs, and make images open in an in-app viewer instead of navigating away.

**Architecture:** Media history is a *projection of the existing `messages` table*, not a second store. Attachments already live in `attachment_*` columns plus `metadata.attachments`; links are extracted from `body`. This inherits `messages_select` RLS (membership + per-member `can_view_history_from` cutoff + admin override) exactly, needs no migration, and covers all pre-existing history with no backfill.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, self-hosted Supabase (PostgREST + Realtime + Storage), Tailwind v4, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-11-media-history-design.md`

## Global Constraints

- **No schema change, no migration.** Media history derives from `messages`.
- **Never write permission logic in app code** — RLS on `messages` is the only gate.
- **Signed storage URLs must be generated at render** and used in a plain `<a href>`. Signing inside a click handler loses the user gesture and mobile Safari blocks the tab. (Established codebase gotcha.)
- **No server-side link fetching** (SSRF surface on this VPS). Link "preview" = hostname + a local letter badge. No third-party favicon service.
- **Out of scope:** linkifying chat bubbles, any call-subsystem change, unrelated refactoring.
- **Verification = `npx tsc --noEmit` + `npx next build` + live QA.** No test runner exists in this repo; do not add one.
- **Live QA uses throwaway `zz`-prefixed accounts only, deleted afterwards.** Never add real staff to test rooms.
- Storage bucket is `attachments`; object path convention is `{room_id}/{uuid}/{filename}`.

---

### Task 1: Extract the shared attachment helper

Move `messageAttachments` out of `ChatRoom.tsx` so the chat bubble and the media panel share one definition. Behavior must be identical.

**Files:**
- Create: `src/lib/media/attachments.ts`
- Modify: `src/components/ChatRoom.tsx` (delete the local `messageAttachments` + `MessageAttachment` type, import instead)

**Interfaces:**
- Produces: `export type MessageAttachment = { path: string; name: string; size: number | null; mime: string | null }` and `export function messageAttachments(msg: Message): MessageAttachment[]`

- [ ] **Step 1: Create the module**

```ts
// src/lib/media/attachments.ts
import type { Message } from "@/lib/types";

export type MessageAttachment = {
  path: string;
  name: string;
  size: number | null;
  mime: string | null;
};

/**
 * Every attachment a file message carries: the first lives in the
 * attachment_* columns, any extras in metadata.attachments.
 */
export function messageAttachments(msg: Message): MessageAttachment[] {
  if (msg.kind !== "file") return [];
  const out: MessageAttachment[] = [];
  if (msg.attachment_path) {
    out.push({
      path: msg.attachment_path,
      name: msg.attachment_name ?? msg.body,
      size: msg.attachment_size,
      mime: msg.attachment_mime,
    });
  }
  const extra = (msg.metadata as { attachments?: unknown } | null)?.attachments;
  if (Array.isArray(extra)) {
    for (const a of extra) {
      if (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string") {
        const rec = a as { path: string; name?: unknown; size?: unknown; mime?: unknown };
        out.push({
          path: rec.path,
          name: typeof rec.name === "string" ? rec.name : "file",
          size: typeof rec.size === "number" ? rec.size : null,
          mime: typeof rec.mime === "string" ? rec.mime : null,
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 2: Update ChatRoom** — delete its local copy of `messageAttachments` and the `MessageAttachment` type, add `import { messageAttachments, type MessageAttachment } from "@/lib/media/attachments";`

- [ ] **Step 3: Verify nothing changed**

Run: `npx tsc --noEmit`
Expected: exit 0. Chat attachment rendering is untouched.

- [ ] **Step 4: Commit**

```bash
git add src/lib/media/attachments.ts src/components/ChatRoom.tsx
git commit -m "Extract messageAttachments into a shared media module."
```

---

### Task 2: Link + category helpers (pure functions)

**Files:**
- Create: `src/lib/media/links.ts`

**Interfaces:**
- Produces: `extractLinks(body: string | null | undefined, cap?: number): string[]`, `linkDomain(url: string): string | null`

- [ ] **Step 1: Write the module**

```ts
// src/lib/media/links.ts

/** http(s) URLs only — no bare "www." guessing, which produces false hits. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Trailing punctuation that commonly abuts a URL written in prose. */
const TRAILING = /[),.;:!?\]}]+$/;

export function extractLinks(
  body: string | null | undefined,
  cap = 10,
): string[] {
  if (!body) return [];
  const found = body.match(URL_RE);
  if (!found) return [];
  const out: string[] = [];
  for (const raw of found) {
    const cleaned = raw.replace(TRAILING, "");
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
```

- [ ] **Step 2: Sanity-check the regex with a scratch script**

Write to the scratchpad (NOT the repo) and run with node:

```js
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[),.;:!?\]}]+$/;
const extract = (b) => (b.match(URL_RE) || []).map((r) => r.replace(TRAILING, ""));
console.log(extract("see https://example.com/a.pdf and http://x.io/b?q=1, thanks"));
console.log(extract("(https://en.wikipedia.org/wiki/Foo_(bar))"));
console.log(extract("no links here"));
```

Expected: `[ 'https://example.com/a.pdf', 'http://x.io/b?q=1' ]`, then a wikipedia URL, then `[]`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/media/links.ts
git commit -m "Add URL extraction and domain helpers for media history."
```

---

### Task 3: Media query layer

**Files:**
- Create: `src/lib/media/history.ts`

**Interfaces:**
- Consumes: `messageAttachments` (Task 1), `extractLinks` (Task 2)
- Produces: `type MediaItem`, `type MediaCategory`, `mediaCategory(item)`, `messagesToMediaItems(messages)`, `fetchRoomMedia(supabase, roomId, opts)`

- [ ] **Step 1: Verify the PostgREST `.or()` filter works against the live DB**

PostgREST uses `*` as the `ilike` wildcard inside `or=`. Confirm before building UI on it:

```bash
# from the repo root, using the service key from the server env
curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "https://chat.icenterconsult.com/sb/rest/v1/messages?select=id&or=(attachment_path.not.is.null,body.ilike.*http*)&limit=3"
```

Expected: a JSON array (possibly empty), NOT an error object. If it errors, fall back to two queries merged client-side.

- [ ] **Step 2: Write the module**

```ts
// src/lib/media/history.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@/lib/types";
import { messageAttachments } from "@/lib/media/attachments";
import { extractLinks } from "@/lib/media/links";

export type MediaCategory = "image" | "document" | "link" | "other";

export type MediaItem = {
  /** Stable React key: message id + slot. */
  key: string;
  messageId: string;
  kind: "file" | "link";
  /** File name, or the URL itself for links. */
  name: string;
  mime: string | null;
  size: number | null;
  /** Storage object path (files only). */
  path?: string;
  /** Absolute URL (links only). */
  url?: string;
  senderId: string | null;
  createdAt: string;
};

const DOC_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "csv",
  "ppt", "pptx", "txt", "rtf", "odt", "ods",
]);

export function mediaCategory(item: MediaItem): MediaCategory {
  if (item.kind === "link") return "link";
  const mime = item.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (DOC_EXT.has(ext)) return "document";
  if (
    mime === "application/pdf" ||
    mime.includes("spreadsheet") ||
    mime.includes("word") ||
    mime.includes("presentation") ||
    mime.startsWith("text/")
  ) {
    return "document";
  }
  return "other";
}

/** Flatten message rows into per-attachment and per-link media items. */
export function messagesToMediaItems(messages: Message[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of messages) {
    if (m.deleted_at) continue;
    messageAttachments(m).forEach((a, i) => {
      out.push({
        key: `${m.id}:f${i}`,
        messageId: m.id,
        kind: "file",
        name: a.name || "file",
        mime: a.mime,
        size: a.size,
        path: a.path,
        senderId: m.sender_id,
        createdAt: m.created_at,
      });
    });
    if (m.kind !== "system") {
      extractLinks(m.body).forEach((u, i) => {
        out.push({
          key: `${m.id}:l${i}`,
          messageId: m.id,
          kind: "link",
          name: u,
          mime: null,
          size: null,
          url: u,
          senderId: m.sender_id,
          createdAt: m.created_at,
        });
      });
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

const MEDIA_COLUMNS =
  "id, room_id, sender_id, kind, body, attachment_path, attachment_name, attachment_size, attachment_mime, metadata, created_at, deleted_at, reply_to, edited_at";

/**
 * Messages in this room that carry an attachment or contain a URL, newest
 * first. RLS does all permission work (membership, history cutoff, admin).
 */
export async function fetchRoomMedia(
  supabase: SupabaseClient,
  roomId: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<Message[]> {
  const limit = opts.limit ?? 200;
  let q = supabase
    .from("messages")
    .select(MEDIA_COLUMNS)
    .eq("room_id", roomId)
    .is("deleted_at", null)
    .or("attachment_path.not.is.null,body.ilike.*http*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.before) q = q.lt("created_at", opts.before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Message[];
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/media/history.ts
git commit -m "Add media history query and projection layer."
```

---

### Task 4: Image lightbox (fixes the image-redirect bug)

Clicking an image currently navigates to the raw signed URL. Replace with an in-app overlay.

**Files:**
- Create: `src/components/ImageLightbox.tsx`
- Modify: `src/components/ChatRoom.tsx` (the image bubble, ~line 1747: currently `<a href={url} target="_blank">` wrapping `<img>`)

**Interfaces:**
- Produces: `<ImageLightbox src={string} name={string} onClose={() => void} />`

- [ ] **Step 1: Create the lightbox**

```tsx
// src/components/ImageLightbox.tsx
"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

/** Full-screen in-app image viewer. Closes on X, backdrop click, or Escape. */
export function ImageLightbox({
  src,
  name,
  onClose,
}: {
  src: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/80 p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <X className="size-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed
          Supabase URLs are short-lived; next/image can't optimize them */}
      <img
        src={src}
        alt={name}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 truncate rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/20"
      >
        Open original
      </a>
    </div>
  );
}
```

- [ ] **Step 2: Use it in the chat image bubble** — in `ChatRoom.tsx`, replace the `<a href={url} target="_blank" …>` wrapper around the image with a `<button type="button" onClick={() => setLightbox({ src: url, name })}>` carrying the same classes, and render `{lightbox && <ImageLightbox … onClose={() => setLightbox(null)} />}`. Keep the `loading="lazy"`, `onLoad`, and `onError` handlers exactly as they are.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → exit 0. Then in the browser: clicking a chat image opens the overlay and does **not** navigate; Escape and the backdrop close it.

- [ ] **Step 4: Commit**

```bash
git add src/components/ImageLightbox.tsx src/components/ChatRoom.tsx
git commit -m "Open chat images in an in-app lightbox instead of navigating away."
```

---

### Task 5: Media history panel

**Files:**
- Create: `src/components/MediaHistory.tsx`

**Interfaces:**
- Consumes: `fetchRoomMedia`, `messagesToMediaItems`, `mediaCategory`, `MediaItem` (Task 3); `linkDomain` (Task 2); `ImageLightbox` (Task 4)
- Produces: `<MediaHistory roomId={string} members={RoomMemberView[]} liveMessages={Message[]} />`

Behaviour:
- On mount, `fetchRoomMedia(roomId)` → `messagesToMediaItems`.
- Merge `liveMessages` (ChatRoom's live array) through the same projection, dedupe by `key`, sort newest-first → realtime with **no new subscription**.
- Batch-sign file paths with `supabase.storage.from("attachments").createSignedUrls(paths, 3600)`; map path → signed URL. Sign at render.
- Search box filters on file name, URL, domain, and sender name (case-insensitive). Filter chips: All / Images / Documents / Links.
- Row shows icon (or domain letter badge for links), name, size, sender name, date/time.
- Image rows open `ImageLightbox`; other files are `<a href={signedUrl} target="_blank" rel="noopener noreferrer">`; links are `<a href={url} target="_blank" rel="noopener noreferrer">`.
- States: loading skeleton, error + Retry, empty ("No files or links shared yet"), and "Load more" when the last fetch returned a full page.

- [ ] **Step 1: Build the component** per the behaviour above, following existing styling conventions (`bg-paper`, `border-line`, `text-ink`, `text-muted`, rounded-xl rows, `Avatar` for the domain badge, `Input` from `@/components/uikit/input` for search, chips styled like `MobileChatsScreen`'s filter chips).
- [ ] **Step 2:** `npx tsc --noEmit` → exit 0.
- [ ] **Step 3: Commit**

```bash
git add src/components/MediaHistory.tsx
git commit -m "Add media history panel with search and type filters."
```

---

### Task 6: Details-sheet entry point (groups + DMs)

**Files:**
- Modify: `src/components/ChatRoom.tsx` (the `<SheetContent>` block, ~lines 1225-1262)

- [ ] **Step 1:** Add `const [detailsTab, setDetailsTab] = useState<"members" | "media">("members");`
- [ ] **Step 2:** Render a two-button segmented toggle ("Members" / "Media") directly under the sheet header, above **both** the DM branch and the `GroupDetails` branch, so one implementation serves both room types.
- [ ] **Step 3:** When `detailsTab === "media"`, render `<MediaHistory roomId={roomId} members={members} liveMessages={messages} />` in place of the members/GroupDetails content.
- [ ] **Step 4:** Reset to `"members"` whenever the sheet closes.
- [ ] **Step 5:** `npx tsc --noEmit` → exit 0.
- [ ] **Step 6: Commit**

```bash
git add src/components/ChatRoom.tsx
git commit -m "Add Members/Media toggle to the conversation details sheet."
```

---

### Task 7: Build check and live verification

- [ ] **Step 1:** `npx tsc --noEmit` → exit 0
- [ ] **Step 2:** `npx next build` → compiles, lint clean
- [ ] **Step 3:** Deploy: `ICC_SSH_PASS='…' bash scripts/deploy.sh`
- [ ] **Step 4: Live QA — group chat.** With two `zz` throwaway accounts in a test group: post a PDF, an image, and a message containing a URL. Open Details → Media. Confirm all three listed with name/type/sender/time; the image opens the lightbox (no navigation); the PDF opens; the link opens; search by file name narrows; each filter chip works.
- [ ] **Step 5: Live QA — DM.** Repeat in a DM between the two throwaways. Confirm the Media tab appears and works identically.
- [ ] **Step 6: Realtime.** With the Media panel open on account A, post a file from account B. Confirm it appears **without refresh**.
- [ ] **Step 7: Permissions.** Confirm a third account that is not a member cannot see that room's media (it cannot open the room at all; RLS returns no rows).
- [ ] **Step 8:** Delete the throwaway accounts.
- [ ] **Step 9: Commit** any fixes found during QA.

---

## Self-Review

**Spec coverage:** group + DM panel (T5, T6); PDFs/Excel/docs/images/other (T3 `mediaCategory`); links (T2, T3); auto-saved (inherent — derived from `messages`); opened from group/DM (T6); name/type/date/sender/link-preview (T5); permissions (RLS, Global Constraints); click opens (T5); search + filters by name/type/link/sender (T5); realtime (T5 merge); persistence via existing DB (T3); build check + error fixes + file list + both-room confirmation (T7). Adjacent image-redirect defect (T4). No spec requirement is unassigned.

**Placeholders:** none — every code step carries real code; Task 5 and 6 steps name exact components, props, filters and states.

**Type consistency:** `MessageAttachment`/`messageAttachments` (T1) are consumed unchanged by T3. `MediaItem` fields (`key`, `messageId`, `kind`, `name`, `mime`, `size`, `path`, `url`, `senderId`, `createdAt`) are produced in T3 and consumed with the same names in T5. `ImageLightbox` props (`src`, `name`, `onClose`) match between T4 and T5.
