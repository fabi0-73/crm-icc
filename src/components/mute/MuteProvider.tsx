"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type MuteState = {
  rooms: string[];
  users: string[];
};

type MuteContextValue = {
  isRoomMuted: (roomId: string) => boolean;
  isUserMuted: (userId: string) => boolean;
  toggleRoomMute: (roomId: string) => void;
  toggleUserMute: (userId: string) => void;
};

const MuteContext = createContext<MuteContextValue | null>(null);

export function useMutes() {
  const ctx = useContext(MuteContext);
  if (!ctx) throw new Error("useMutes must be used inside MuteProvider");
  return ctx;
}

function storageKey(userId: string) {
  return `icc-mutes:${userId}`;
}

function load(userId: string): MuteState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return { rooms: [], users: [] };
    const parsed = JSON.parse(raw) as MuteState;
    return {
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      users: Array.isArray(parsed.users) ? parsed.users : [],
    };
  } catch {
    return { rooms: [], users: [] };
  }
}

function toggleId(list: string[], id: string) {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function MuteProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<MuteState>({ rooms: [], users: [] });

  useEffect(() => {
    setState(load(userId));
  }, [userId]);

  const persist = useCallback(
    (next: MuteState) => {
      setState(next);
      localStorage.setItem(storageKey(userId), JSON.stringify(next));
    },
    [userId],
  );

  const isRoomMuted = useCallback(
    (roomId: string) => state.rooms.includes(roomId),
    [state.rooms],
  );
  const isUserMuted = useCallback(
    (userIdToCheck: string) => state.users.includes(userIdToCheck),
    [state.users],
  );
  const toggleRoomMute = useCallback(
    (roomId: string) => {
      persist({ ...state, rooms: toggleId(state.rooms, roomId) });
    },
    [persist, state],
  );
  const toggleUserMute = useCallback(
    (targetId: string) => {
      persist({ ...state, users: toggleId(state.users, targetId) });
    },
    [persist, state],
  );

  const value = useMemo(
    () => ({
      isRoomMuted,
      isUserMuted,
      toggleRoomMute,
      toggleUserMute,
    }),
    [isRoomMuted, isUserMuted, toggleRoomMute, toggleUserMute],
  );

  return <MuteContext.Provider value={value}>{children}</MuteContext.Provider>;
}
