"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";

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
