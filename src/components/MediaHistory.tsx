"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  File as FileIcon,
  FileAudio,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Link2,
  Search,
} from "lucide-react";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/uikit/sheet";
import { ImageLightbox } from "@/components/ImageLightbox";
import { createClient } from "@/lib/supabase/client";
import { fetchRoomMediaMessages } from "@/lib/supabase/realtime";
import {
  CATEGORY_LABEL,
  formatBytes,
  linkDetail,
  matchesFilter,
  matchesQuery,
  mediaItemsFrom,
  MEDIA_FILTERS,
  type MediaFilter,
  type MediaItem,
} from "@/lib/chat/media";
import { publicDisplayName } from "@/lib/display-name";
import type { Message, RoomMemberView } from "@/lib/types";

/** Signed URLs last an hour — longer than anyone keeps this panel open. */
const SIGN_TTL_SECONDS = 3600;

function formatWhen(iso: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString([], {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

function CategoryIcon({ item }: { item: MediaItem }) {
  const className = "size-[18px]";
  switch (item.category) {
    case "link":
      return <Link2 className={className} />;
    case "image":
      return <ImageIcon className={className} />;
    case "excel":
      return <FileSpreadsheet className={className} />;
    case "pdf":
    case "document":
      return <FileText className={className} />;
    case "media":
      return <FileAudio className={className} />;
    case "archive":
      return <Archive className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

/**
 * Files and links shared in one conversation, oldest send to newest,
 * with search and type filters. The stored history comes from the
 * messages table; `liveMessages` is the open room's state, so anything
 * sent or received while the panel is open shows up without a refresh.
 */
export function MediaHistory({
  roomId,
  liveMessages,
  members,
}: {
  roomId: string;
  liveMessages: Message[];
  members: RoomMemberView[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [stored, setStored] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [signed, setSigned] = useState<Record<string, string>>({});
  const [extraNames, setExtraNames] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(
    null,
  );
  const signRequestedRef = useRef<Set<string>>(new Set());
  const nameRequestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRoomMediaMessages(supabase, roomId)
      .then((rows) => {
        if (cancelled) return;
        setStored(rows);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, roomId]);

  const items = useMemo(
    () => mediaItemsFrom([...stored, ...liveMessages]),
    [stored, liveMessages],
  );

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    members.forEach((m) => map.set(m.id, publicDisplayName(m)));
    Object.entries(extraNames).forEach(([id, name]) => {
      if (!map.has(id)) map.set(id, name);
    });
    return map;
  }, [members, extraNames]);

  // Someone who has since left the room still authored their files.
  useEffect(() => {
    const missing = [
      ...new Set(
        items
          .map((i) => i.senderId)
          .filter((id): id is string => Boolean(id))
          .filter((id) => !nameById.has(id) && !nameRequestedRef.current.has(id)),
      ),
    ];
    if (missing.length === 0) return;
    missing.forEach((id) => nameRequestedRef.current.add(id));
    let cancelled = false;
    void supabase
      .from("profiles")
      .select("id, full_name, public_name")
      .in("id", missing)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setExtraNames((prev) => ({
          ...prev,
          ...Object.fromEntries(
            data.map((p) => [p.id, publicDisplayName(p)] as const),
          ),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [items, nameById, supabase]);

  // Signed in one batch, so every row can be a plain <a>: signing inside
  // a click handler loses the user gesture and mobile Safari blocks it.
  useEffect(() => {
    const paths = [
      ...new Set(
        items
          .map((i) => i.path)
          .filter((p): p is string => Boolean(p))
          .filter((p) => !signRequestedRef.current.has(p)),
      ),
    ];
    if (paths.length === 0) return;
    paths.forEach((p) => signRequestedRef.current.add(p));
    let cancelled = false;
    void supabase.storage
      .from("attachments")
      .createSignedUrls(paths, SIGN_TTL_SECONDS)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const fresh: Record<string, string> = {};
        for (const row of data) {
          if (row.path && row.signedUrl) fresh[row.path] = row.signedUrl;
        }
        if (Object.keys(fresh).length > 0) {
          setSigned((prev) => ({ ...prev, ...fresh }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [items, supabase]);

  const shown = useMemo(
    () =>
      items.filter(
        (item) =>
          matchesFilter(item, filter) &&
          matchesQuery(
            item,
            (item.senderId && nameById.get(item.senderId)) || "",
            query,
          ),
      ),
    [items, filter, query, nameById],
  );

  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle>Files &amp; links</SheetTitle>
        <SheetDescription>
          {loading
            ? "Loading shared media…"
            : failed
              ? "Could not load the media history."
              : `${items.length} ${items.length === 1 ? "item" : "items"} shared in this conversation`}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="space-y-2 border-b border-line px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, type, sender or link"
              aria-label="Search files and links"
              className="w-full rounded-lg border border-line bg-paper py-2 pl-9 pr-3 text-[14px] text-ink outline-none placeholder:text-muted focus:border-brand-400"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MEDIA_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${
                  filter === f.id
                    ? "bg-brand-600 text-white"
                    : "border border-line text-muted hover:bg-mist hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {shown.map((item) => (
            <li key={item.id}>
              <MediaRow
                item={item}
                senderName={
                  (item.senderId && nameById.get(item.senderId)) || "Unknown"
                }
                url={item.path ? (signed[item.path] ?? null) : item.url}
                onPreviewImage={(url) => setPreview({ url, name: item.name })}
              />
            </li>
          ))}
          {!loading && shown.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-muted">
              {failed
                ? "Could not load the media history. Close this panel and open it again."
                : items.length === 0
                  ? "No files or links have been shared here yet."
                  : "Nothing matches this search."}
            </li>
          )}
        </ul>
      </div>

      {preview && (
        <ImageLightbox
          url={preview.url}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

function MediaRow({
  item,
  senderName,
  url,
  onPreviewImage,
}: {
  item: MediaItem;
  senderName: string;
  /** Signed URL for files, the target for links; null until signed. */
  url: string | null;
  onPreviewImage: (url: string) => void;
}) {
  const size = formatBytes(item.size);
  const meta = [CATEGORY_LABEL[item.category], size, senderName]
    .filter(Boolean)
    .join(" · ");

  const body = (
    <>
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg ${
          item.kind === "link"
            ? "bg-secondary text-brand-700 dark:text-brand-300"
            : "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
        }`}
      >
        {item.category === "image" && url ? (
          /* eslint-disable-next-line @next/next/no-img-element -- signed
             Supabase URLs are short-lived; next/image can't optimize them */
          <img
            src={url}
            alt={item.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <CategoryIcon item={item} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">
          {item.name}
        </span>
        <span className="block truncate text-[12px] text-muted">{meta}</span>
        {item.kind === "link" && (
          <span className="block truncate text-[12px] text-brand-700 dark:text-brand-300">
            {linkDetail(item.url ?? "") || item.url}
          </span>
        )}
        {item.kind === "link" && item.context && (
          <span className="block truncate text-[11.5px] text-muted">
            {item.context}
          </span>
        )}
        <span className="block text-[11.5px] text-muted">
          {formatWhen(item.createdAt)}
        </span>
      </span>
    </>
  );

  const shell =
    "flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-mist";

  if (item.category === "image") {
    return url ? (
      <button type="button" onClick={() => onPreviewImage(url)} className={shell}>
        {body}
      </button>
    ) : (
      <div className={`${shell} opacity-70`}>{body}</div>
    );
  }

  if (!url) {
    return <div className={`${shell} opacity-70`}>{body}</div>;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel={
        item.kind === "link"
          ? "noopener noreferrer nofollow"
          : "noopener noreferrer"
      }
      className={shell}
    >
      {body}
    </a>
  );
}
