"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile, requireRole } from "@/lib/auth";
import type { ActionState } from "@/app/actions/admin";
import { historyFromPreset } from "@/lib/history-presets";
import type { HistoryPreset } from "@/lib/types";

/**
 * Room openers return the id instead of redirecting: the caller closes
 * its modal and navigates. Redirecting from inside the action left the
 * desktop sidebar's modal open on top of the new room, and Next masks
 * thrown action messages in production so errors were invisible.
 */
export type RoomActionResult = { roomId?: string; error?: string };

function actionError(e: unknown, fallback: string) {
  const message = e instanceof Error ? e.message : "";
  if (message === "Permission denied") return "You don't have access to do that.";
  if (message === "Not authenticated") return "Your session expired. Sign in again.";
  return message || fallback;
}

export async function createGroup(formData: FormData): Promise<RoomActionResult> {
  try {
    const { supabase } = await requireRole(["admin", "manager"]);
    const name = String(formData.get("name") ?? "").trim();
    const memberRaw = String(formData.get("member_ids") ?? "");
    const memberIds = memberRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!name) return { error: "Give the group a name." };

    const { data: roomId, error } = await supabase.rpc("create_group_room", {
      p_name: name,
      p_member_ids: memberIds,
    });

    if (error) return { error: error.message };
    return { roomId: roomId as string };
  } catch (e) {
    return { error: actionError(e, "Could not create the group.") };
  }
}

/** Open (or create) the caller's DM with another staff member. */
export async function openDm(otherUserId: string): Promise<RoomActionResult> {
  try {
    const { supabase } = await requireRole(["admin", "manager", "assistant"]);
    const { data: roomId, error } = await supabase.rpc("get_or_create_dm", {
      p_other_user: otherUserId,
    });
    if (error) return { error: error.message };
    return { roomId: roomId as string };
  } catch (e) {
    return { error: actionError(e, "Could not open the chat.") };
  }
}

/** Admin/manager joining a room they can see but aren't a member of. */
export async function joinRoom(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const roomId = String(formData.get("room_id") ?? "");
  if (!roomId) return { error: "Missing room." };

  try {
    const { supabase, user } = await requireRole(["admin", "manager"]);
    const { error } = await supabase.rpc("add_room_member", {
      p_room_id: roomId,
      p_user_id: user.id,
      p_history_from: null,
    });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: actionError(e, "Could not join the conversation.") };
  }

  revalidatePath(`/rooms/${roomId}`);
  redirect(`/rooms/${roomId}`);
}

export async function addRoomMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin", "manager"]);
  const roomId = String(formData.get("room_id") ?? "");
  const userId = String(formData.get("user_id") ?? "");
  const preset = String(
    formData.get("history_preset") ?? "full",
  ) as HistoryPreset;

  if (!roomId || !userId) return { error: "Missing room or user." };

  const { error } = await supabase.rpc("add_room_member", {
    p_room_id: roomId,
    p_user_id: userId,
    p_history_from: historyFromPreset(preset),
  });

  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: "Member added." };
}

export async function removeRoomMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin", "manager"]);
  const roomId = String(formData.get("room_id") ?? "");
  const userId = String(formData.get("user_id") ?? "");

  if (!roomId || !userId) return { error: "Missing room or user." };

  const { error } = await supabase.rpc("remove_room_member", {
    p_room_id: roomId,
    p_user_id: userId,
  });

  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: "Member removed." };
}

export async function markRoomRead(roomId: string) {
  const { supabase } = await requireProfile();
  await supabase.rpc("mark_room_read", { p_room_id: roomId });
}
