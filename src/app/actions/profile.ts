"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

export async function updateMyPublicName(
  _prev: { error?: string; success?: string },
  formData: FormData,
): Promise<{ error?: string; success?: string }> {
  const { supabase } = await requireRole(["assistant", "agent"]);
  const publicName = String(formData.get("public_name") ?? "");
  const { error } = await supabase.rpc("update_my_public_name", {
    p_public_name: publicName,
  });
  if (error) return { error: error.message };
  revalidatePath("/account");
  revalidatePath("/rooms");
  return { success: "Public name updated." };
}
