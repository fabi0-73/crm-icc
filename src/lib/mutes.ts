"use client";

import { useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Notification mutes: whole conversations, or one person everywhere.
 *
 * They live in the database (notification_mutes, own rows only) so a mute
 * follows the person to every device and the push sender can honour it
 * for a closed app. This module is the in-browser copy: a small store that
 * RoomsProvider reads synchronously inside its realtime callback, and that
 * every toggle updates at once. Mutes silence message sounds, pop-ups and
 * pushes; calls still ring.
 */
type Snapshot = {
  rooms: ReadonlySet<string>;
  users: ReadonlySet<string>;
};

const EMPTY: ReadonlySet<string> = new Set();
let snapshot: Snapshot = { rooms: EMPTY, users: EMPTY };
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean) {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Where mutes lived before they moved to the server (one browser only). */
const LEGACY_KEY = "icc.notify.muted-rooms.v1";

function readLegacy(): string[] {
  try {
    const arr = JSON.parse(window.localStorage.getItem(LEGACY_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeLegacy(ids: string[]) {
  try {
    if (ids.length) window.localStorage.setItem(LEGACY_KEY, JSON.stringify(ids));
    else window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage unavailable — nothing to carry over then */
  }
}

/**
 * Read the signed-in person's mutes. The first time on each browser it
 * also carries over rooms muted there before mutes moved to the server.
 */
export async function loadMutes(): Promise<void> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("notification_mutes")
    .select("room_id, muted_user_id");
  if (error || !data) return;

  const rooms = new Set<string>();
  const users = new Set<string>();
  for (const row of data as {
    room_id: string | null;
    muted_user_id: string | null;
  }[]) {
    if (row.room_id) rooms.add(row.room_id);
    if (row.muted_user_id) users.add(row.muted_user_id);
  }

  // One at a time: a room this person has since left is refused by RLS,
  // and that must not sink the rest of the batch.
  const keep: string[] = [];
  for (const roomId of readLegacy()) {
    if (rooms.has(roomId)) continue;
    const { error: insertError } = await supabase
      .from("notification_mutes")
      .insert({ room_id: roomId });
    if (!insertError || insertError.code === "23505") rooms.add(roomId);
    else if (insertError.code !== "42501") keep.push(roomId); // retry later
  }
  writeLegacy(keep);

  publish({ rooms, users });
}

async function write(
  column: "room_id" | "muted_user_id",
  id: string,
  muted: boolean,
): Promise<void> {
  const supabase = createClient();
  const row: { room_id?: string; muted_user_id?: string } =
    column === "room_id" ? { room_id: id } : { muted_user_id: id };
  const { error } = muted
    ? await supabase.from("notification_mutes").insert(row)
    : await supabase.from("notification_mutes").delete().eq(column, id);
  // 23505: already muted (another tab or device got there first).
  if (error && error.code !== "23505") throw error;
}

export async function setRoomMuted(roomId: string, muted: boolean) {
  publish({ ...snapshot, rooms: toggled(snapshot.rooms, roomId, muted) });
  try {
    await write("room_id", roomId, muted);
  } catch {
    publish({ ...snapshot, rooms: toggled(snapshot.rooms, roomId, !muted) });
  }
}

export async function setUserMuted(userId: string, muted: boolean) {
  publish({ ...snapshot, users: toggled(snapshot.users, userId, muted) });
  try {
    await write("muted_user_id", userId, muted);
  } catch {
    publish({ ...snapshot, users: toggled(snapshot.users, userId, !muted) });
  }
}

export function isRoomMuted(roomId: string): boolean {
  return snapshot.rooms.has(roomId);
}

export function isUserMuted(userId: string): boolean {
  return snapshot.users.has(userId);
}

export function useRoomMuted(roomId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.rooms.has(roomId),
    () => false,
  );
}

export function useUserMuted(userId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.users.has(userId),
    () => false,
  );
}
