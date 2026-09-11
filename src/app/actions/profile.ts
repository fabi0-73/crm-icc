"use server";

import { revalidatePath } from "next/cache";
import { requireProfile, requireRole } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { emailToUsername } from "@/lib/username";

/**
 * Usernames for the new-message picker. Only admins and managers see
 * them (they already do on Users); for everyone else the picker falls
 * back to searching names, which is all they are allowed to know.
 */
export async function lookupUsernames(): Promise<Record<string, string>> {
  const { profile } = await requireProfile();
  if (profile.role !== "admin" && profile.role !== "manager") return {};
  try {
    const service = createServiceClient();
    const { data } = await service.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    const out: Record<string, string> = {};
    for (const u of data?.users ?? []) {
      out[u.id] = emailToUsername(u.email ?? "");
    }
    return out;
  } catch {
    return {};
  }
}

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
