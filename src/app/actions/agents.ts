"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import {
  friendlyAuthError,
  generatePassword,
  isValidUsername,
  USERNAME_HINT,
  usernameToEmail,
} from "@/lib/username";
import type { ActionState } from "@/app/actions/admin";
import { historyFromPreset } from "@/lib/history-presets";
import type { HistoryPreset } from "@/lib/types";

export async function createAgent(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor, supabase } = await requireRole(["admin"]);

  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const fullName =
    String(formData.get("full_name") ?? "").trim() || displayName;
  let password = String(formData.get("password") ?? "").trim();

  if (!username || !displayName) {
    return { error: "Display name and username are required." };
  }
  if (!isValidUsername(username)) {
    return { error: `Invalid username. ${USERNAME_HINT}` };
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
      error: friendlyAuthError(
        createError?.message,
        "Failed to create agent account.",
      ),
    };
  }

  const userId = created.user.id;

  const { error: profileError } = await service.from("profiles").insert({
    id: userId,
    full_name: fullName,
    role: "agent",
    is_active: true,
  });

  if (profileError) {
    await service.auth.admin.deleteUser(userId);
    return { error: profileError.message };
  }

  // Transactional agent + workspace room via RPC (caller's session).
  const { data: agentId, error: rpcError } = await supabase.rpc(
    "create_agent_with_room",
    { p_user_id: userId, p_display_name: displayName },
  );

  if (rpcError) {
    await service.from("profiles").delete().eq("id", userId);
    await service.auth.admin.deleteUser(userId);
    return { error: rpcError.message };
  }

  // Extra audit from service path for the auth account itself.
  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "user.created",
    target_type: "profile",
    target_id: userId,
    metadata: { username, role: "agent", full_name: fullName, agent_id: agentId },
  });

  // No revalidatePath — see createUserAccount: refreshing the route here
  // remounts the form and discards the one-time password.
  return {
    success: `Agent ${displayName} created. Share these — the password isn't shown again:`,
    credentials: { username, password },
  };
}

export async function archiveAgent(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile: actor } = await requireRole(["admin"]);
  const agentId = String(formData.get("agent_id") ?? "");
  if (!agentId) return { error: "Missing agent." };

  const service = createServiceClient();
  const { data: agent, error: fetchError } = await service
    .from("agents")
    .select("id, user_id, display_name")
    .eq("id", agentId)
    .single();

  if (fetchError || !agent) return { error: "Agent not found." };

  const { error } = await service
    .from("agents")
    .update({ status: "archived" })
    .eq("id", agentId);

  if (error) return { error: error.message };

  await service
    .from("profiles")
    .update({ is_active: false })
    .eq("id", agent.user_id);

  await service.auth.admin.updateUserById(agent.user_id, {
    ban_duration: "876000h",
  });

  // Close the assignments too, otherwise the agent keeps showing as
  // staffed and the assistants keep the workspace in their sidebar with
  // no hint that it is closed.
  await service
    .from("assignments")
    .update({
      removed_at: new Date().toISOString(),
      removed_by: actor.id,
      removal_reason: "Agent archived",
    })
    .eq("agent_id", agentId)
    .is("removed_at", null);

  const { data: room } = await service
    .from("rooms")
    .select("id")
    .eq("agent_id", agentId)
    .eq("type", "agent_workspace")
    .maybeSingle();

  if (room) {
    await service.from("messages").insert({
      room_id: room.id,
      sender_id: null,
      kind: "system",
      body: `${agent.display_name} was archived`,
      metadata: { event: "agent_archived" },
    });
  }

  await service.from("audit_logs").insert({
    actor_id: actor.id,
    action: "agent.archived",
    target_type: "agent",
    target_id: agentId,
    metadata: { display_name: agent.display_name },
  });

  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
  return { success: "Agent archived." };
}

export async function swapAssistants(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin"]);

  const agentId = String(formData.get("agent_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const removeRaw = String(formData.get("remove_ids") ?? "");
  const addUserId = String(formData.get("add_user_id") ?? "").trim();
  const preset = String(formData.get("history_preset") ?? "none") as HistoryPreset;

  if (!agentId) return { error: "Missing agent." };

  const removeIds = removeRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const additions =
    addUserId.length > 0
      ? [
          {
            user_id: addUserId,
            history_from: historyFromPreset(preset),
          },
        ]
      : [];

  if (removeIds.length === 0 && additions.length === 0) {
    return { error: "Select at least one assistant to add or remove." };
  }

  const { error } = await supabase.rpc("swap_assistants", {
    p_agent_id: agentId,
    p_remove_ids: removeIds,
    p_additions: additions,
    p_reason: reason,
  });

  if (error) return { error: error.message };

  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/rooms");
  return { success: "Assignment updated." };
}

export async function setAgentManager(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { supabase } = await requireRole(["admin"]);
  const agentId = String(formData.get("agent_id") ?? "");
  const managerId = String(formData.get("manager_id") ?? "").trim();
  if (!agentId) return { error: "Missing agent." };

  const { error } = await supabase.rpc("set_agent_manager", {
    p_agent_id: agentId,
    p_manager_id: managerId || null,
  });
  if (error) return { error: error.message };
  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/agents");
  return { success: "Manager assignment saved." };
}
