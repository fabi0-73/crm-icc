"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import {
  emailToUsername,
  friendlyAuthError,
  generatePassword,
  isValidUsername,
  USERNAME_HINT,
  usernameToEmail,
} from "@/lib/username";
import type { Role } from "@/lib/types";

export type ActionState = {
  error?: string;
  success?: string;
  /** Shown exactly once after create/reset — never stored anywhere else. */
  credentials?: { username: string; password: string };
};

const STAFF_ROLES: Role[] = ["admin", "manager", "assistant"];

export async function createUserAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);

  const fullName = String(formData.get("full_name") ?? "").trim();
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as Role;
  let password = String(formData.get("password") ?? "").trim();

  if (!fullName || !username) {
    return { error: "Name and username are required." };
  }
  if (!isValidUsername(username)) {
    return { error: `Invalid username. ${USERNAME_HINT}` };
  }
  if (!STAFF_ROLES.includes(role)) {
    return { error: "Invalid role. Agent accounts are created via Agents." };
  }
  if (password && password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (!password) password = generatePassword();

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return { error: friendlyAuthError((e as Error).message, "Server misconfigured.") };
  }

  const { data: created, error: createError } =
    await service.auth.admin.createUser({
      email: usernameToEmail(username),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, username },
    });

  if (createError || !created.user) {
    return {
      error: friendlyAuthError(createError?.message, "Failed to create user."),
    };
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
    action: "user.created",
    target_type: "profile",
    target_id: userId,
    metadata: { username, role, full_name: fullName },
  });

  // Deliberately no revalidatePath here: it refreshes the route, which
  // remounts this form and wipes the one-time password off the screen.
  // The list refreshes when the admin closes the dialog.
  return {
    success: `${fullName} can sign in now. Share these — the password isn't shown again:`,
    credentials: { username, password },
  };
}

export async function resetUserPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing user." };
  if (userId === actor.id) {
    // An admin password reset ends every session that user has — including
    // the one clicking the button.
    return {
      error: "Change your own password from Account instead.",
    };
  }

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return { error: friendlyAuthError((e as Error).message, "Server misconfigured.") };
  }

  const { data: target, error: fetchError } =
    await service.auth.admin.getUserById(userId);
  if (fetchError || !target.user) return { error: "User not found." };

  const password = generatePassword();
  const { error } = await service.auth.admin.updateUserById(userId, {
    password,
  });
  if (error) return { error: error.message };

  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "user.password_reset",
    target_type: "profile",
    target_id: userId,
    metadata: {},
  });

  return {
    success: "New password set — the old one stopped working. Share it now:",
    credentials: {
      username: emailToUsername(target.user.email ?? ""),
      password,
    },
  };
}

export async function deactivateUser(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");

  if (!userId) return { error: "Missing user." };
  if (userId === actor.id) return { error: "You cannot deactivate yourself." };

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return { error: friendlyAuthError((e as Error).message, "Server misconfigured.") };
  }

  const { error } = await service
    .from("profiles")
    .update({ is_active: false })
    .eq("id", userId);

  if (error) return { error: error.message };

  // Ban so existing sessions stop working immediately. If this fails the
  // account would be half-deactivated (locked out of the app, still able
  // to hold a session), so put the profile back and report it.
  const { error: banError } = await service.auth.admin.updateUserById(userId, {
    ban_duration: "876000h",
  });
  if (banError) {
    await service.from("profiles").update({ is_active: true }).eq("id", userId);
    return { error: `Could not deactivate: ${banError.message}` };
  }

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

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return { error: friendlyAuthError((e as Error).message, "Server misconfigured.") };
  }

  const { error } = await service
    .from("profiles")
    .update({ is_active: true })
    .eq("id", userId);

  if (error) return { error: error.message };

  // Without a successful unban the profile would read "Active" while the
  // person still cannot sign in.
  const { error: unbanError } = await service.auth.admin.updateUserById(
    userId,
    { ban_duration: "none" },
  );
  if (unbanError) {
    await service.from("profiles").update({ is_active: false }).eq("id", userId);
    return { error: `Could not reactivate: ${unbanError.message}` };
  }

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
