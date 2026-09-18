"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { ensureRealtimeAuth } from "@/lib/supabase/realtime";

type Urls = Record<string, string | null>;

type Ctx = {
  urls: Urls;
  remember: (userId: string, url: string | null) => void;
  ensure: (userId: string) => void;
  setUrl: (userId: string, url: string | null) => void;
};

const ProfileAvatarsContext = createContext<Ctx | null>(null);

/**
 * Live map of user id → profile picture. Seeded by whatever the page
 * already loaded, then kept current by postgres_changes on profiles so
 * a new photo shows up in chats, lists and calls without a refresh.
 */
export function ProfileAvatarsProvider({
  initial,
  children,
}: {
  initial?: Urls;
  children: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [urls, setUrls] = useState<Urls>(initial ?? {});
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!initial) return;
    setUrls((prev) => ({ ...initial, ...prev }));
  }, [initial]);

  const setUrl = useCallback((userId: string, url: string | null) => {
    setUrls((prev) => (prev[userId] === url ? prev : { ...prev, [userId]: url }));
  }, []);

  const remember = useCallback((userId: string, url: string | null) => {
    setUrls((prev) => (userId in prev ? prev : { ...prev, [userId]: url }));
  }, []);

  const ensure = useCallback(
    (userId: string) => {
      if (!userId || pending.current.has(userId)) return;
      setUrls((prev) => {
        if (userId in prev) return prev;
        pending.current.add(userId);
        void supabase
          .from("profiles")
          .select("avatar_url")
          .eq("id", userId)
          .maybeSingle()
          .then(({ data }) => {
            pending.current.delete(userId);
            setUrl(userId, (data?.avatar_url as string | null) ?? null);
          });
        return prev;
      });
    },
    [setUrl, supabase],
  );

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = supabase
        .channel("profiles:avatars")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles" },
          (payload) => {
            const row = payload.new as { id?: string; avatar_url?: string | null };
            if (row.id) setUrl(row.id, row.avatar_url ?? null);
          },
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [setUrl, supabase]);

  const value = useMemo(
    () => ({ urls, remember, ensure, setUrl }),
    [urls, remember, ensure, setUrl],
  );

  return (
    <ProfileAvatarsContext.Provider value={value}>
      {children}
    </ProfileAvatarsContext.Provider>
  );
}

export function useProfileAvatar(
  userId?: string | null,
  known?: string | null,
) {
  const ctx = useContext(ProfileAvatarsContext);
  useEffect(() => {
    if (!ctx || !userId) return;
    if (known !== undefined) ctx.remember(userId, known);
    else ctx.ensure(userId);
  }, [ctx, userId, known]);
  if (!userId) return known ?? null;
  if (ctx && userId in ctx.urls) return ctx.urls[userId];
  return known ?? null;
}

export function useSetProfileAvatar() {
  const ctx = useContext(ProfileAvatarsContext);
  return ctx?.setUrl ?? (() => {});
}
