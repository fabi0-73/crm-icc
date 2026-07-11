"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile, requireRole } from "@/lib/auth";
import type { ActionState } from "@/app/actions/admin";
import { historyFromPreset } from "@/lib/history-presets";
import type { HistoryPreset } from "@/lib/types";

export async function createGroupAndRedirect(formData: FormData) {
  const { supabase } = await requireRole(["admin", "manager"]);
  const name = String(formData.get("name") ?? "").trim();
  const memberRaw = String(formData.get("member_ids") ?? "");
  const memberIds = memberRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { data: roomId, error } = await supabase.rpc("create_group_room", {
    p_name: name,
    p_member_ids: memberIds,
  });

  if (error) throw new Error(error.message);
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

/** Open (or create) the caller's DM with another staff member. */
export async function openDm(otherUserId: string) {
  const { supabase } = await requireRole(["admin", "manager", "assistant"]);
  const { data: roomId, error } = await supabase.rpc("get_or_create_dm", {
    p_other_user: otherUserId,
  });
  if (error) throw new Error(error.message);
  redirect(`/rooms/${roomId}`);
}
