"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/Avatar";
import { Input } from "@/components/uikit/input";
import { ImageLightbox } from "@/components/ImageLightbox";
import {
  fetchRoomMedia,
  mediaCategory,
  messagesToMediaItems,
  type MediaCategory,
  type MediaItem,
} from "@/lib/media/history";
import { linkDomain } from "@/lib/media/links";
import type { Message, RoomMemberView } from "@/lib/types";

const PAGE = 200;
/** Storage signing is batched; keep each batch reasonable. */
const SIGN_BATCH = 100;
const SIGN_TTL_S = 3600;

type Filter = "all" | MediaCategory;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "image", label: "Images" },
  { key: "document", label: "Documents" },
  { key: "link", label: "Links" },
];

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * Files and links shared in this conversation, newest first.
 *
 * Reads straight from the messages table (see lib/media/history), so it shows
 * all history including anything sent before this panel existed, survives
 * logout/login, and inherits the room's read permissions from RLS. Realtime
 * needs no extra subscription: `liveMessages` is ChatRoom's already-live
 * array, merged in here.
 */
export function MediaHistory({
  roomId,
  members,
  liveMessages,
}: {
  roomId: string;
  members: RoomMemberView[];
  liveMessages: Message[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [fetched, setFetched] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [signed, setSigned] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null);
  /** Paths we've already tried to sign, so a failure never loops. */
  const attempted = useRef<Set<string>>(new Set());

  const nameById = useMemo(
    () => new Map(members.map((m) => [m.id, m.full_name])),
    [members],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchRoomMedia(supabase, roomId, { limit: PAGE });
      setFetched(rows);
      setHasMore(rows.length === PAGE);
    } catch {
      setError("Could not load shared files.");
    } finally {
      setLoading(false);
    }
  }, [roomId, supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  // Merge the fetched page with ChatRoom's live messages. Live wins on
  // conflict so an edit or delete is reflected without refetching.
  const items = useMemo(() => {
    const byId = new Map<string, Message>();
    for (const m of fetched) byId.set(m.id, m);
    for (const m of liveMessages) {
      if (m.room_id === roomId) byId.set(m.id, m);
    }
    return messagesToMediaItems([...byId.values()]);
  }, [fetched, liveMessages, roomId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (filter !== "all" && mediaCategory(it) !== filter) return false;
      if (!q) return true;
      const sender = (it.senderId ? nameById.get(it.senderId) : "") ?? "";
      const domain = it.url ? (linkDomain(it.url) ?? "") : "";
      return (
        it.name.toLowerCase().includes(q) ||
        sender.toLowerCase().includes(q) ||
        domain.toLowerCase().includes(q)
      );
    });
  }, [items, query, filter, nameById]);

  // Sign the visible file objects. Signed at render (never in the click
  // handler) — signing on click loses the user gesture and mobile Safari
  // then blocks the tab.
  useEffect(() => {
    const paths = Array.from(
      new Set(
        visible
          .filter((i) => i.kind === "file" && i.path)
          .map((i) => i.path as string)
          .filter((p) => !attempted.current.has(p)),
      ),
    ).slice(0, SIGN_BATCH);
    if (paths.length === 0) return;
    paths.forEach((p) => attempted.current.add(p));

    let cancelled = false;
    void (async () => {
      const { data } = await supabase.storage
        .from("attachments")
        .createSignedUrls(paths, SIGN_TTL_S);
      if (cancelled || !data) return;
      setSigned((prev) => {
        const next = { ...prev };
        for (const d of data) {
          if (d.signedUrl && d.path) next[d.path] = d.signedUrl;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, supabase]);

  async function loadMore() {
    const oldest = fetched.length
      ? fetched[fetched.length - 1].created_at
      : null;
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const rows = await fetchRoomMedia(supabase, roomId, {
        before: oldest,
        limit: PAGE,
      });
      setFetched((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE);
    } catch {
      setError("Could not load older files.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files, links, people"
            aria-label="Search shared files and links"
            className="h-10 rounded-full border-line/80 bg-paper pl-9 text-[14px]"
          />
        </div>
        <div className="no-scrollbar mt-2.5 flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold transition-colors ${
                  active
                    ? "bg-ink text-white"
                    : "border border-line/80 bg-paper text-muted hover:bg-mist"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <ul className="space-y-2 p-1">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="h-14 animate-pulse rounded-xl bg-line/50" />
            ))}
          </ul>
        ) : error ? (
          <div className="p-6 text-center">
            <p className="text-[13px] text-muted">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 rounded-full bg-brand-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700"
            >
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted">
            {items.length === 0
              ? "No files or links shared yet."
              : "Nothing matches that search."}
          </p>
        ) : (
          <>
            <ul className="space-y-0.5">
              {visible.map((item) => (
                <MediaRow
                  key={item.key}
                  item={item}
                  senderName={
                    (item.senderId ? nameById.get(item.senderId) : null) ??
                    "Someone"
                  }
                  signedUrl={item.path ? signed[item.path] : undefined}
                  onZoom={setZoom}
                />
              ))}
            </ul>
            {hasMore && (
              <div className="p-3 text-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="rounded-full border border-line bg-paper px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-mist disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load older"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {zoom && (
        <ImageLightbox
          src={zoom.src}
          name={zoom.name}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}

function RowShell({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-mist">
      {children}
    </span>
  );
}

function RowMeta({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[14px] font-medium text-ink">
        {title}
      </span>
      <span className="block truncate text-[12px] text-muted">{subtitle}</span>
    </span>
  );
}

function MediaRow({
  item,
  senderName,
  signedUrl,
  onZoom,
}: {
  item: MediaItem;
  senderName: string;
  signedUrl?: string;
  onZoom: (v: { src: string; name: string }) => void;
}) {
  const category = mediaCategory(item);
  const when = formatWhen(item.createdAt);

  if (item.kind === "link" && item.url) {
    const domain = linkDomain(item.url) ?? "link";
    return (
      <li>
        <a href={item.url} target="_blank" rel="noopener noreferrer">
          <RowShell>
            <Avatar name={domain} size="sm" />
            <RowMeta title={domain} subtitle={`${senderName} · ${when}`} />
            <span className="max-w-[38%] shrink-0 truncate text-[11px] text-muted">
              {item.url.replace(/^https?:\/\//, "")}
            </span>
          </RowShell>
        </a>
      </li>
    );
  }

  const size = formatBytes(item.size);
  const subtitle = `${senderName} · ${when}${size ? ` · ${size}` : ""}`;
  const Icon =
    category === "image" ? ImageIcon : category === "document" ? FileText : Paperclip;

  const icon = (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
      <Icon className="size-[18px]" />
    </span>
  );

  if (!signedUrl) {
    return (
      <li>
        <RowShell>
          {icon}
          <RowMeta title={item.name} subtitle={subtitle} />
        </RowShell>
      </li>
    );
  }

  // Images open in the in-app viewer; everything else opens normally.
  if (category === "image") {
    return (
      <li>
        <button
          type="button"
          className="w-full"
          onClick={() => onZoom({ src: signedUrl, name: item.name })}
        >
          <RowShell>
            {icon}
            <RowMeta title={item.name} subtitle={subtitle} />
          </RowShell>
        </button>
      </li>
    );
  }

  return (
    <li>
      <a href={signedUrl} target="_blank" rel="noopener noreferrer">
        <RowShell>
          {icon}
          <RowMeta title={item.name} subtitle={subtitle} />
        </RowShell>
      </a>
    </li>
  );
}
