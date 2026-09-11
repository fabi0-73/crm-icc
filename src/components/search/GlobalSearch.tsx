"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, MessagesSquare, Search, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/Modal";
import { Avatar } from "@/components/Avatar";
import { openDm } from "@/app/actions/rooms";
import { stripFormatting } from "@/lib/chat/rich-text";

export type SearchResult = {
  kind: "conversation" | "person" | "message";
  room_id: string | null;
  room_type: string | null;
  message_id: string | null;
  user_id: string | null;
  title: string;
  subtitle: string | null;
  created_at: string;
};

const DEBOUNCE_MS = 220;

/**
 * One search box over everything the signed-in person may see:
 * conversations, the people they can message, and message history
 * (group and private). Results are produced by the global_search RPC,
 * which applies the same membership rules as the chat itself.
 */
export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      const { data, error: rpcError } = await supabase.rpc("global_search", {
        p_query: q,
        p_limit: 40,
      });
      if (cancelled) return;
      setLoading(false);
      if (rpcError) {
        setError(rpcError.message);
        setResults([]);
        return;
      }
      setError(null);
      setResults((data ?? []) as SearchResult[]);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, supabase]);

  async function open(result: SearchResult) {
    if (result.kind === "person" && result.user_id) {
      const res = await openDm(result.user_id);
      if (res.error || !res.roomId) {
        setError(res.error ?? "Could not open that chat.");
        return;
      }
      onClose();
      router.push(`/rooms/${res.roomId}`);
      return;
    }
    if (!result.room_id) return;
    onClose();
    router.push(
      result.message_id
        ? `/rooms/${result.room_id}?m=${result.message_id}`
        : `/rooms/${result.room_id}`,
    );
  }

  const groups: { label: string; items: SearchResult[] }[] = [
    {
      label: "Conversations",
      items: results.filter((r) => r.kind === "conversation"),
    },
    { label: "People", items: results.filter((r) => r.kind === "person") },
    { label: "Messages", items: results.filter((r) => r.kind === "message") },
  ].filter((g) => g.items.length > 0);

  return (
    <Modal title="Search" open onClose={onClose}>
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="People, conversations, messages…"
            className="h-10 w-full rounded-lg border border-line bg-paper pl-9 pr-3 text-[15px] text-ink outline-none placeholder:text-muted focus:border-brand-500"
            aria-label="Search"
          />
        </div>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="max-h-80 overflow-y-auto">
          {query.trim().length < 2 ? (
            <p className="px-1 py-6 text-center text-sm text-muted">
              Type at least two characters.
            </p>
          ) : loading ? (
            <p className="px-1 py-6 text-center text-sm text-muted">Searching…</p>
          ) : groups.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted">
              Nothing matches “{query.trim()}”.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="mb-2">
                <p className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {group.label}
                </p>
                <ul>
                  {group.items.map((r) => (
                    <li key={`${r.kind}:${r.message_id ?? r.room_id ?? r.user_id}`}>
                      <button
                        type="button"
                        onClick={() => void open(r)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-mist"
                      >
                        <ResultIcon result={r} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">
                            {r.title}
                          </span>
                          {r.subtitle && (
                            <span className="block truncate text-xs text-muted">
                              {r.kind === "message"
                                ? stripFormatting(r.subtitle)
                                : r.subtitle}
                            </span>
                          )}
                        </span>
                        {r.kind === "message" && (
                          <span
                            suppressHydrationWarning
                            className="shrink-0 text-[11px] tabular-nums text-muted"
                          >
                            {new Date(r.created_at).toLocaleDateString()}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

function ResultIcon({ result }: { result: SearchResult }) {
  if (result.kind === "person") {
    return <Avatar name={result.title} size="sm" className="!h-7 !w-7 !text-[10px]" />;
  }
  if (result.kind === "conversation") {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
        {result.room_type === "dm" ? (
          <User className="size-4" />
        ) : (
          <Hash className="size-4" />
        )}
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted">
      <MessagesSquare className="size-4" />
    </span>
  );
}
