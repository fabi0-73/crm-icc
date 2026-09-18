"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile, requireRole } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
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

/**
 * Open (or create) the caller's DM with another person. Agents are allowed
 * through here too — they may DM assistants (agent↔assistant private chats).
 * The exact pairing rules (staff↔staff, agent↔assistant) are enforced in the
 * get_or_create_dm RPC, so this only needs to admit an active account.
 */
export async function openDm(otherUserId: string): Promise<RoomActionResult> {
  try {
    const { supabase } = await requireRole([
      "admin",
      "manager",
      "assistant",
      "agent",
    ]);
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
  // Any active staff member may reach the RPC; the group-vs-workspace
  // and admin-only rules are enforced there against the caller's
  // membership, not by app role alone.
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

/**
 * Delete a group entirely. Authorization is enforced in the delete_room RPC:
 * an app admin may delete ANY group; a manager or assistant may delete only a
 * group they created. The RPC removes the messages, memberships, and the room
 * (call_signals cascade; audit rows are detached, not lost) in one transaction
 * and returns the attachment object paths it orphaned, which we then sweep from
 * storage — the DB has no FK to the storage bucket, so nothing else does it.
 */
export async function deleteRoom(roomId: string): Promise<RoomActionResult> {
  if (!roomId) return { error: "Missing room." };
  try {
    const { supabase } = await requireRole(["admin", "manager", "assistant"]);
    const { data: paths, error } = await supabase.rpc("delete_room", {
      p_room_id: roomId,
    });
    if (error) return { error: error.message };

    // Best-effort storage cleanup. The room row is already gone, so a failure
    // here only leaves harmless orphaned blobs — never block on it.
    const attachmentPaths = ((paths as string[] | null) ?? []).filter(Boolean);
    if (attachmentPaths.length) {
      try {
        const service = createServiceClient();
        await service.storage.from("attachments").remove(attachmentPaths);
      } catch {
        /* orphaned attachment objects are harmless; ignore */
      }
    }

    revalidatePath("/rooms", "layout");
    return { roomId };
  } catch (e) {
    return { error: actionError(e, "Could not delete the group.") };
  }
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

/**
 * Chat wallpaper for a group. Any signed-in member may call it; the
 * set_room_background function is the gate — it allows the Admin role
 * and that group's own admins, and rejects DMs and workspaces.
 */
export async function setRoomBackground(
  roomId: string,
  backgroundUrl: string | null,
): Promise<{ error?: string; success?: string }> {
  const { supabase } = await requireProfile();
  if (!roomId) return { error: "Missing room." };

  const { error } = await supabase.rpc("set_room_background", {
    p_room_id: roomId,
    p_background_url: backgroundUrl,
  });
  if (error) return { error: error.message };
  revalidatePath(`/rooms/${roomId}`);
  return { success: "Chat background updated." };
}

export async function editMessage(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("message_id") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const roomId = String(formData.get("room_id") ?? "");
  if (!id) return { error: "Missing message." };
  if (!body) return { error: "Message cannot be empty." };

  try {
    const { supabase } = await requireRole(["admin", "manager", "assistant"]);
    const { error } = await supabase.rpc("edit_message", {
      p_id: id,
      p_body: body,
    });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: actionError(e, "Could not edit the message.") };
  }
  if (roomId) revalidatePath(`/rooms/${roomId}`);
  return { success: "Message edited." };
}

export async function deleteMessage(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("message_id") ?? "");
  const roomId = String(formData.get("room_id") ?? "");
  if (!id) return { error: "Missing message." };

  try {
    const { supabase } = await requireRole(["admin", "manager", "assistant"]);
    const { error } = await supabase.rpc("delete_message", { p_id: id });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: actionError(e, "Could not delete the message.") };
  }
  if (roomId) revalidatePath(`/rooms/${roomId}`);
  return { success: "Message deleted." };
}

/**
 * Pin or unpin a message. Admins and managers only — enforced in the
 * set_message_pinned RPC, so this allowlist is a fast path, not the gate.
 */
export async function setMessagePinned(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("message_id") ?? "");
  const roomId = String(formData.get("room_id") ?? "");
  const pinned = String(formData.get("pinned") ?? "") === "true";
  if (!id) return { error: "Missing message." };

  try {
    const { supabase } = await requireRole(["admin", "manager"]);
    const { error } = await supabase.rpc("set_message_pinned", {
      p_id: id,
      p_pinned: pinned,
    });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: actionError(e, "Could not pin the message.") };
  }
  if (roomId) revalidatePath(`/rooms/${roomId}`);
  return { success: pinned ? "Message pinned." : "Message unpinned." };
}

export async function markRoomRead(roomId: string) {
  const { supabase } = await requireProfile();
  await supabase.rpc("mark_room_read", { p_room_id: roomId });
}
