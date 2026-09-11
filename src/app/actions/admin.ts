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

/** What deleting an account would take with it. */
export type DeletionFootprint = {
  username: string;
  fullName: string;
  role: Role;
  /** Messages they sent, everywhere. Deleting the account deletes these. */
  messages: number;
  /** Conversations they belong to (their membership rows go). */
  memberships: number;
  /** 1:1 chats that get removed outright — a DM with one person is nothing. */
  dmRooms: number;
  /** Agent workspace that goes with them, if this is an agent account. */
  workspace: { name: string; messages: number } | null;
  /** Rooms and agents they created — these stay, ownership moves to you. */
  reassigned: number;
  /** Audit entries kept, with the actor cleared. */
  auditEntries: number;
  /** Content is at stake, so the admin has to type the username. */
  needsTypedConfirmation: boolean;
  blockedReason?: string;
};

const STAFF_ROLES: Role[] = ["admin", "manager", "assistant"];

export async function createUserAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin", "manager"]);

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
  // Managers may provision regular staff (assistants) only.
  if (actor.role === "manager" && role !== "assistant") {
    return { error: "Managers can only add regular users." };
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

export async function updateAssistantName(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");
  const fullName = String(formData.get("full_name") ?? "").trim();
  if (!userId || !fullName) return { error: "Name is required." };

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return { error: friendlyAuthError((e as Error).message, "Server misconfigured.") };
  }

  const { data: target } = await service
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();
  if (!target || target.role !== "assistant") {
    return { error: "Only assistant names can be edited here." };
  }

  const { error } = await service
    .from("profiles")
    .update({ full_name: fullName })
    .eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath("/admin/users");
  revalidatePath("/rooms");
  return { success: "Name updated." };
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

/* ── Account deletion ─────────────────────────────────────────────────
 *
 * Deactivation stays the right answer for someone who has left: it keeps
 * their history readable. Deletion is for the other case — typos,
 * duplicates, leftover demo accounts — and has to be honest about what
 * it destroys, because a person is referenced from nine places.
 *
 * The rule: anything that is theirs alone goes (their messages, their
 * memberships, their 1:1 chats, an agent's own workspace); anything
 * shared stays, with "created by / added by" moved to the acting admin,
 * so nobody else's conversation breaks. Audit rows survive with the
 * actor cleared.
 */

type Service = ReturnType<typeof createServiceClient>;

async function countRows(
  service: Service,
  table: string,
  column: string,
  value: string,
) {
  const { count } = await service
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value);
  return count ?? 0;
}

/** Rooms that stop making sense once this person is gone. */
async function roomsToRemove(service: Service, userId: string) {
  const { data: memberRows } = await service
    .from("room_members")
    .select("room_id")
    .eq("user_id", userId);
  const memberIds = (memberRows ?? []).map((r) => r.room_id);

  const dmIds: string[] = [];
  if (memberIds.length) {
    const { data: dms } = await service
      .from("rooms")
      .select("id")
      .in("id", memberIds)
      .eq("type", "dm");
    dmIds.push(...(dms ?? []).map((r) => r.id));
  }

  const { data: agent } = await service
    .from("agents")
    .select("id, display_name")
    .eq("user_id", userId)
    .maybeSingle<{ id: string; display_name: string }>();

  let workspaceId: string | null = null;
  if (agent) {
    const { data: ws } = await service
      .from("rooms")
      .select("id")
      .eq("agent_id", agent.id)
      .eq("type", "agent_workspace")
      .maybeSingle();
    workspaceId = ws?.id ?? null;
  }

  return {
    agent,
    workspaceId,
    dmIds,
    all: [...dmIds, ...(workspaceId ? [workspaceId] : [])],
  };
}

async function buildFootprint(
  service: Service,
  userId: string,
  actorId: string,
): Promise<DeletionFootprint | null> {
  const { data: profile } = await service
    .from("profiles")
    .select("full_name, role")
    .eq("id", userId)
    .maybeSingle<{ full_name: string; role: Role }>();
  if (!profile) return null;

  const { data: target } = await service.auth.admin.getUserById(userId);
  const username = emailToUsername(target?.user?.email ?? "") || "this account";

  const { agent, workspaceId, dmIds } = await roomsToRemove(service, userId);

  const [
    messages,
    memberships,
    createdRooms,
    createdAgents,
    addedBy,
    assignedBy,
    auditEntries,
  ] = await Promise.all([
    countRows(service, "messages", "sender_id", userId),
    countRows(service, "room_members", "user_id", userId),
    countRows(service, "rooms", "created_by", userId),
    countRows(service, "agents", "created_by", userId),
    countRows(service, "room_members", "added_by", userId),
    countRows(service, "assignments", "assigned_by", userId),
    countRows(service, "audit_logs", "actor_id", userId),
  ]);

  let workspace: DeletionFootprint["workspace"] = null;
  if (agent && workspaceId) {
    workspace = {
      name: agent.display_name,
      messages: await countRows(service, "messages", "room_id", workspaceId),
    };
  }

  let blockedReason: string | undefined;
  if (userId === actorId) {
    blockedReason = "You can't delete the account you're signed in with.";
  } else if (profile.role === "admin") {
    const { count } = await service
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_active", true);
    if ((count ?? 0) <= 1) {
      blockedReason =
        "This is the last active admin — make someone else an admin first.";
    }
  }

  return {
    username,
    fullName: profile.full_name,
    role: profile.role,
    messages,
    memberships,
    dmRooms: dmIds.length,
    workspace,
    reassigned: createdRooms + createdAgents + addedBy + assignedBy,
    auditEntries,
    needsTypedConfirmation: messages > 0 || Boolean(workspace),
    blockedReason,
  };
}

/** Managers may only delete regular users (assistants); admins, anyone. */
function deletionScopeError(actorRole: Role, targetRole: Role) {
  if (actorRole === "manager" && targetRole !== "assistant") {
    return "Managers can only delete regular users.";
  }
  return null;
}

/** Read-only preview for the delete dialog. */
export async function describeUserDeletion(
  userId: string,
): Promise<{ footprint?: DeletionFootprint; error?: string }> {
  const { profile: actor } = await requireRole(["admin", "manager"]);
  if (!userId) return { error: "Missing user." };

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return {
      error: friendlyAuthError((e as Error).message, "Server misconfigured."),
    };
  }

  const footprint = await buildFootprint(service, userId, actor.id);
  if (!footprint) return { error: "That account no longer exists." };
  const scope = deletionScopeError(actor.role, footprint.role);
  if (scope) return { error: scope };
  return { footprint };
}

export async function deleteUserAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin", "manager"]);
  const userId = String(formData.get("user_id") ?? "");
  const typed = String(formData.get("confirm") ?? "").trim();
  if (!userId) return { error: "Missing user." };

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    return {
      error: friendlyAuthError((e as Error).message, "Server misconfigured."),
    };
  }

  // Recomputed here: the dialog's numbers are a preview, not permission.
  const footprint = await buildFootprint(service, userId, actor.id);
  if (!footprint) return { error: "That account no longer exists." };
  const scope = deletionScopeError(actor.role, footprint.role);
  if (scope) return { error: scope };
  if (footprint.blockedReason) return { error: footprint.blockedReason };
  if (
    footprint.needsTypedConfirmation &&
    typed.toLowerCase() !== footprint.username.toLowerCase()
  ) {
    return { error: `Type ${footprint.username} to confirm this deletion.` };
  }

  const { agent, all: doomedRooms } = await roomsToRemove(service, userId);

  // Rooms that go entirely: strip their contents first (only call_signals
  // cascade), keeping audit rows by detaching them from the room.
  if (doomedRooms.length) {
    await service
      .from("audit_logs")
      .update({ room_id: null })
      .in("room_id", doomedRooms);
    await service.from("messages").delete().in("room_id", doomedRooms);
    await service.from("room_members").delete().in("room_id", doomedRooms);
  }

  // Their traces in rooms other people keep using.
  const { error: msgError } = await service
    .from("messages")
    .delete()
    .eq("sender_id", userId);
  if (msgError) {
    return { error: `Could not remove their messages: ${msgError.message}` };
  }
  await service.from("room_members").delete().eq("user_id", userId);
  await service.from("assignments").delete().eq("assistant_id", userId);
  if (agent) await service.from("assignments").delete().eq("agent_id", agent.id);

  if (doomedRooms.length) {
    const { error } = await service.from("rooms").delete().in("id", doomedRooms);
    if (error) {
      return { error: `Could not remove their conversations: ${error.message}` };
    }
  }
  if (agent) {
    const { error } = await service.from("agents").delete().eq("id", agent.id);
    if (error) {
      return { error: `Could not remove the agent record: ${error.message}` };
    }
  }

  // Shared records survive; ownership moves to whoever pressed delete.
  await service.from("rooms").update({ created_by: actor.id }).eq("created_by", userId);
  await service.from("room_members").update({ added_by: actor.id }).eq("added_by", userId);
  await service.from("assignments").update({ assigned_by: actor.id }).eq("assigned_by", userId);
  await service.from("assignments").update({ removed_by: actor.id }).eq("removed_by", userId);
  await service.from("agents").update({ created_by: actor.id }).eq("created_by", userId);
  await service.from("audit_logs").update({ actor_id: null }).eq("actor_id", userId);

  const { error: profileError } = await service
    .from("profiles")
    .delete()
    .eq("id", userId);
  if (profileError) {
    return { error: `Could not delete the profile: ${profileError.message}` };
  }

  const { error: authError } = await service.auth.admin.deleteUser(userId);
  if (authError) {
    return {
      error: `Profile removed, but the login could not be deleted: ${authError.message}`,
    };
  }

  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "user.deleted",
    target_type: "profile",
    target_id: userId,
    metadata: {
      username: footprint.username,
      full_name: footprint.fullName,
      role: footprint.role,
      messages_removed: footprint.messages,
      rooms_removed: doomedRooms.length,
    },
  });

  // No revalidatePath: it remounts the dialog's form and swallows the
  // result, so the dialog would never close. The client refreshes the
  // table once it has handled the outcome.
  return { success: `${footprint.fullName} was deleted.` };
}
