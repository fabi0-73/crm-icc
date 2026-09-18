import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Profile, Role } from "@/lib/types";

/** Dedupes auth+profile within a single RSC request (layout + page). */
export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
});

export const getCurrentProfile = cache(async () => {
  const { supabase, user } = await getSessionUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active, created_at, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !profile.is_active) return null;
  return { supabase, user, profile: profile as Profile };
});

export async function requireUser() {
  const { supabase, user } = await getSessionUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, user };
}

export async function requireProfile() {
  const ctx = await getCurrentProfile();
  if (!ctx) throw new Error("Not authenticated");
  return ctx;
}

export async function requireRole(roles: Role[]) {
  const ctx = await requireProfile();
  if (!roles.includes(ctx.profile.role)) {
    throw new Error("Permission denied");
  }
  return ctx;
}
