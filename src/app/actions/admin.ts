"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/types";

export type ActionState = { error?: string; success?: string };

const STAFF_ROLES: Role[] = ["admin", "manager", "assistant"];

export async function inviteUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const role = String(formData.get("role") ?? "") as Role;

  if (!email || !fullName) {
    return { error: "Name and email are required." };
  }
  if (!STAFF_ROLES.includes(role)) {
    return { error: "Invalid role. Agent accounts are created via Agents." };
  }

  const service = createServiceClient();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const { data: created, error: createError } =
    await service.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

  if (createError || !created.user) {
    return { error: createError?.message ?? "Failed to create user." };
  }

  const userId = created.user.id;

  const { error: profileError } = await service.from("profiles").insert({
    id: userId,
    full_name: fullName,
    role,
    is_active: true,
  });

  if (profileError) {
    await service.auth.admin.deleteUser(userId);
    return { error: profileError.message };
  }

  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "user.invited",
    target_type: "profile",
    target_id: userId,
    metadata: { email, role, full_name: fullName },
  });

  const { error: linkError } = await service.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo: `${siteUrl}/auth/reset-password` },
  });

  // Invite email is best-effort; account exists either way.
  if (linkError) {
    revalidatePath("/admin/users");
    return {
      success: `User created, but invite email failed: ${linkError.message}. Share a password-reset link manually.`,
    };
  }

  // Also send the invite via inviteUserByEmail if available — generateLink
  // creates the link; for email delivery use resetPasswordForEmail as fallback.
  await service.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl}/auth/reset-password`,
  });

  revalidatePath("/admin/users");
  return { success: `Invited ${fullName} as ${role}.` };
}

export async function deactivateUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");

  if (!userId) return { error: "Missing user." };
  if (userId === actor.id) return { error: "You cannot deactivate yourself." };

  const service = createServiceClient();

  const { error } = await service
    .from("profiles")
    .update({ is_active: false })
    .eq("id", userId);

  if (error) return { error: error.message };

  // Ban so existing JWTs stop working on next refresh / sign-in.
  await service.auth.admin.updateUserById(userId, {
    ban_duration: "876000h",
  });

  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "user.deactivated",
    target_type: "profile",
    target_id: userId,
    metadata: {},
  });

  revalidatePath("/admin/users");
  return { success: "User deactivated." };
}

export async function reactivateUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing user." };

  const service = createServiceClient();

  const { error } = await service
    .from("profiles")
    .update({ is_active: true })
    .eq("id", userId);

  if (error) return { error: error.message };

  await service.auth.admin.updateUserById(userId, { ban_duration: "none" });

  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "user.reactivated",
    target_type: "profile",
    target_id: userId,
    metadata: {},
  });

  revalidatePath("/admin/users");
  return { success: "User reactivated." };
}
