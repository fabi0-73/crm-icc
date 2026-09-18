"use server";

import { revalidatePath } from "next/cache";
import { requireProfile, requireRole } from "@/lib/auth";
import type { ActionState } from "@/app/actions/admin";

/**
 * An assistant or agent sets the name shown in chats and calls. Admins and
 * managers have no public name — they rename their account (updateMyName).
 * update_my_public_name enforces the same rule and writes only auth.uid().
 */
export async function updateMyPublicName(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["assistant", "agent"]);
  const publicName = String(formData.get("public_name") ?? "").trim();
  if (publicName.length > 80) return { error: "Keep it under 80 characters." };
  const { error } = await supabase.rpc("update_my_public_name", {
    p_public_name: publicName,
  });
  if (error) return { error: error.message };
  revalidatePath("/account");
  revalidatePath("/rooms", "layout");
  return { success: "Name updated." };
}

/** Only the signed-in user — update_my_avatar_url writes auth.uid(). */
export async function updateMyAvatarUrl(
  avatarUrl: string | null,
): Promise<{ error?: string; url?: string | null }> {
  const { supabase } = await requireProfile();
  const { error } = await supabase.rpc("update_my_avatar_url", {
    p_avatar_url: avatarUrl ?? "",
  });
  if (error) return { error: error.message };
  revalidatePath("/account");
  revalidatePath("/rooms");
  return { url: avatarUrl };
}
