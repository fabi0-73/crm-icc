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

    const avatarUrl = String(formData.get("avatar_url") ?? "").trim();

    if (!name) return { error: "Give the group a name." };

    const { data: roomId, error } = await supabase.rpc("create_group_room", {
      p_name: name,
      p_member_ids: memberIds,
      p_avatar_url: avatarUrl || null,
    });

    if (error) return { error: error.message };
    return { roomId: roomId as string };
  } catch (e) {
    return { error: actionError(e, "Could not create the group.") };
  }
}

/** Open (or create) a 1:1. Staff↔staff, or assigned agent↔assistant. */
export async function openDm(otherUserId: string): Promise<RoomActionResult> {
  try {
    const { supabase } = await requireProfile();
    const { data: roomId, error } = await supabase.rpc("get_or_create_dm", {
      p_other_user: otherUserId,
    });
    if (error) return { error: error.message };
    return { roomId: roomId as string };
  } catch (e) {
    return { error: actionError(e, "Could not open the chat.") };
  }
}

export async function postCallEvent(
  roomId: string,
  event: "call_started" | "call_ended",
  body: string,
) {
  const { supabase } = await requireProfile();
  await supabase.rpc("post_call_event", {
    p_room_id: roomId,
    p_event: event,
    p_body: body,
  });
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
  // Assistants may call this only when they are a room admin; the RPC
  // enforces that. App admins/managers may add to any group.
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
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
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
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

export async function leaveRoom(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const roomId = String(formData.get("room_id") ?? "");
  if (!roomId) return { error: "Missing room." };

  try {
    const { supabase } = await requireRole(["admin", "manager", "assistant"]);
    const { error } = await supabase.rpc("leave_room", { p_room_id: roomId });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: actionError(e, "Could not leave the group.") };
  }

  // Refresh the shell's room list; the client navigates away itself
  // (calling this action imperatively means we can't redirect here).
  revalidatePath("/rooms", "layout");
  return { success: "You left the group." };
}

export async function setRoomMemberRole(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
  const roomId = String(formData.get("room_id") ?? "");
  const userId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!roomId || !userId) return { error: "Missing room or user." };

  const { error } = await supabase.rpc("set_room_member_role", {
    p_room_id: roomId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: role === "admin" ? "Now an admin." : "Now a member." };
}

export async function renameRoom(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
  const roomId = String(formData.get("room_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!roomId) return { error: "Missing room." };
  if (!name) return { error: "Give the group a name." };

  const { error } = await supabase.rpc("rename_room", {
    p_room_id: roomId,
    p_name: name,
  });
  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: "Group renamed." };
}

export async function setRoomAvatar(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
  const roomId = String(formData.get("room_id") ?? "");
  const avatarUrl = String(formData.get("avatar_url") ?? "").trim();
  if (!roomId) return { error: "Missing room." };

  const { error } = await supabase.rpc("set_room_avatar", {
    p_room_id: roomId,
    p_avatar_url: avatarUrl || null,
  });
  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: "Group image updated." };
}

export async function setRoomBackground(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
  const roomId = String(formData.get("room_id") ?? "");
  const backgroundUrl = String(formData.get("background_url") ?? "").trim();
  if (!roomId) return { error: "Missing room." };

  const { error } = await supabase.rpc("set_room_background", {
    p_room_id: roomId,
    p_background_url: backgroundUrl || null,
  });
  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: "Chat background updated." };
}

/** Admins delete any channel; managers only ones they manage. */
export async function deleteRoom(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const roomId = String(formData.get("room_id") ?? "");
  if (!roomId) return { error: "Missing room." };

  try {
    const { supabase } = await requireRole(["admin", "manager"]);
    const { error } = await supabase.rpc("delete_room", { p_room_id: roomId });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: actionError(e, "Could not delete the channel.") };
  }

  revalidatePath("/rooms", "layout");
  return { success: "Channel deleted." };
}

/** Pin/unpin a message. Admins and managers only (enforced again in SQL). */
export async function setMessagePinned(
  messageId: string,
  pinned: boolean,
): Promise<{ error?: string }> {
  try {
    const { supabase } = await requireRole(["admin", "manager"]);
    const { error } = await supabase.rpc("set_message_pinned", {
      p_message_id: messageId,
      p_pinned: pinned,
    });
    if (error) return { error: error.message };
    return {};
  } catch (e) {
    return { error: actionError(e, "Could not update the pin.") };
  }
}

export async function markRoomRead(roomId: string) {
  const { supabase } = await requireProfile();
  await supabase.rpc("mark_room_read", { p_room_id: roomId });
}

export async function markRoomDelivered(roomId: string) {
  const { supabase } = await requireProfile();
  await supabase.rpc("mark_room_delivered", { p_room_id: roomId });
}
