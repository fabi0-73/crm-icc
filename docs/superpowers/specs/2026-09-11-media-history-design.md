# Media history for files and links — design

Date: 2026-09-11
Status: approved

## Problem

Files and links shared in a conversation are only reachable by scrolling the
chat history. There is no way to answer "where is that PDF someone sent last
week" without hunting. Two related gaps:

1. No per-conversation index of shared attachments or links.
2. Links are not detected at all today — a URL in a message is plain text, not
   even clickable.

Plus one adjacent defect found while designing: clicking an image in chat
navigates the tab to the raw signed file URL (`ChatRoom.tsx` image bubble wraps
`<img>` in `<a href={signedUrl} target="_blank">`), which reads as "opening an
image redirects to another page" instead of opening a viewer.

## Goals

- A media history panel for BOTH group chats and direct messages, listing
  previously shared attachments (PDF, Excel, documents, images, other) and
  links.
- Show file name, file type, date/time sent, sender; for links show the URL and
  its domain.
- Clicking an item opens the file or link. Images open in an in-app viewer.
- Search and filter by name, file type, links, and sender.
- New files/links appear immediately, with no refresh.
- Persists across logout/login; backed by the database, not chat state.
- A user only ever sees media for conversations they belong to.

## Non-goals

- Linkifying URLs inside chat bubbles (separate change).
- Server-side link preview fetching (title/description/image). Rejected: the
  VPS runs Supabase, coturn and other services on localhost/docker, so fetching
  user-supplied URLs server-side is an SSRF surface. Not worth it here.
- Any change to the call subsystem or unrelated refactoring.

## Approach: derive from `messages` (no schema change)

Media history is a projection of the existing `messages` table rather than a
second store.

`messages` already carries everything needed: `attachment_path`,
`attachment_name`, `attachment_size`, `attachment_mime`, extra attachments in
`metadata.attachments`, `body` (where links live), `sender_id`, `created_at`,
and `deleted_at`.

The decisive reason is permissions. The current `messages_select` policy
(migration 0010) already enforces:

- the viewer is an active user,
- AND (they are an app admin OR they are a member of the room AND the message
  is at/after their `room_members.can_view_history_from` cutoff).

Deriving inherits all of that exactly. A separate `media_items` table would
have to re-implement membership, the per-member history cutoff, the admin
override, and stay in sync through soft deletes — two sources of truth for a
privacy rule, which is where leaks come from. Deriving also covers all
pre-existing history with no backfill, and satisfies the persistence
requirement by construction (it *is* the durable table).

Rejected alternatives: (B) `media_items` table + trigger — more moving parts,
backfill, sync and permission-drift risk; (C) derive + a link index/generated
column — a pure optimization, available later if volume ever demands it.

## Components

### `src/lib/media/attachments.ts` (new)

`messageAttachments(msg): MessageAttachment[]` moved verbatim out of
`ChatRoom.tsx` so the chat bubble and the media panel share one definition.
Behavior unchanged. This is the only pre-existing code being moved, and only
because both consumers need it.

### `src/lib/media/links.ts` (new)

- `extractLinks(body): string[]` — finds `http(s)://` URLs, deduped, capped per
  message.
- `linkDomain(url): string | null` — hostname via `new URL`, used for the
  domain badge. Malformed URLs are skipped.

Preview is a **local domain badge** (hostname + a letter tile in the existing
`Avatar` style). Deliberately not a third-party favicon service, which would
leak every domain the team shares into an external log.

### `src/lib/media/history.ts` (new)

```
type MediaItem = {
  key: string;          // messageId + index, stable for React
  messageId: string;
  kind: "file" | "link";
  name: string;         // file name, or the URL
  mime: string | null;
  size: number | null;
  path?: string;        // storage object path (files)
  url?: string;         // absolute URL (links)
  senderId: string | null;
  createdAt: string;
};
```

- `fetchRoomMedia(supabase, roomId, { before?, limit })` — selects the media
  columns from `messages` where `room_id` matches, `deleted_at is null`, and
  `.or("attachment_path.not.is.null,body.ilike.%http%")`, ordered
  `created_at desc`, limited. `before` pages older items.
- `messagesToMediaItems(messages): MediaItem[]` — flattens rows: each
  attachment becomes a file item, each extracted URL a link item.
- `mediaCategory(item): "image" | "document" | "link" | "other"` — from mime
  and file extension (pdf/doc/docx/xls/xlsx/csv/ppt/txt → document).

The `body.ilike.%http%` filter is a cheap prefilter; exact extraction happens
in `extractLinks`. The room filter is served by the existing
`messages_by_room (room_id, created_at desc)` index.

### `src/components/ImageLightbox.tsx` (new)

In-app image viewer: fixed overlay, the image centred, close on the X, on
backdrop click, and on Escape. Includes an "Open original" link for
download/zoom. Used by chat image bubbles and by media history, replacing the
navigation that caused the reported redirect.

### `src/components/MediaHistory.tsx` (new)

- Props: `roomId`, `members` (for sender names), `liveMessages` (ChatRoom's
  current message array, for realtime merge).
- Search input + filter chips: All / Images / Documents / Links.
- Rows: type icon or domain badge, name, size, sender name, date/time.
- Files are opened through a signed URL generated **at render** behind a plain
  `<a href>`. Signing inside the click handler loses the user gesture and
  mobile Safari blocks the tab — an established gotcha in this codebase.
  Signed URLs are batched with `createSignedUrls`.
- Image rows open the lightbox instead of navigating.
- Empty state, error state with retry, and "Load more" for older items.

### `src/components/ChatRoom.tsx` (modified)

- Import `messageAttachments` from the new module instead of defining it.
- Image bubble opens `ImageLightbox` instead of `<a href target=_blank>`.
- The existing right-hand Details sheet gains a **"Members | Media"** toggle at
  the top. One implementation serves both room types, because the DM branch and
  the `GroupDetails` branch already share that sheet.

## Data flow

1. Panel opens → `fetchRoomMedia` returns the most recent page.
2. Rows flatten into `MediaItem`s; sender names resolve from the `members` map
   already held by `ChatRoom` (fallback "Someone").
3. Visible file items get batch-signed URLs.
4. Realtime: no new subscription. `ChatRoom` already streams message inserts;
   the panel merges that live array into its list, deduped by message id, so a
   file or link posted while the panel is open shows up at once.
5. Search/filter run client-side over the loaded set for instant feedback.

## Permissions

Entirely inherited from `messages_select` RLS: non-members get no rows, a
member sees nothing before their history cutoff, admins see all. No
permission logic is written in application code.

## Error handling

- Fetch failure → inline message with retry; the rest of the sheet still works.
- Signing failure → the row still lists, marked unavailable, click disabled.
- Malformed/relative URLs → skipped by the extractor.
- Soft-deleted messages → excluded by the query.

## Verification

1. `npx tsc --noEmit` and `npx next build`.
2. Live check in a **group** and a **DM**: post a file and a link, confirm both
   appear in Media with no refresh; search by name, filter by type and sender;
   click a file (opens), click an image (lightbox, no navigation), click a link.
3. Confirm a non-member sees nothing for that room.
4. Testing uses throwaway `zz`-prefixed accounts, deleted afterwards; never
   real staff accounts.
