"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { sitePath } from "@/lib/site-url";
import { usernameToEmail } from "@/lib/username";

export type AuthState = { error?: string; success?: string };

const DEACTIVATED = "This account has been deactivated. Ask an admin to restore it.";

export async function signIn(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const identifier = String(formData.get("identifier") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/rooms");

  if (!identifier || !password) {
    return { error: "Username and password are required." };
  }

  const email = usernameToEmail(identifier);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Deactivating bans the auth user, so this is what a deactivated
    // person actually hits — never show them GoTrue's "User is banned".
    if (error.code === "user_banned" || error.message === "User is banned") {
      return { error: DEACTIVATED };
    }
    return {
      error:
        error.message === "Invalid login credentials"
          ? "Wrong username or password."
          : error.message,
    };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_active, role")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile?.is_active) {
      await supabase.auth.signOut({ scope: "local" });
      return { error: DEACTIVATED };
    }
  }

  const h = await headers();
  const dest = next.startsWith("/") ? next : "/rooms";
  redirect(sitePath(dest, h));
}

export async function signOut() {
  const supabase = await createClient();
  // Local scope only: a global sign-out would also kill this person's
  // phone session every time they sign out on the desktop.
  await supabase.auth.signOut({ scope: "local" });
  const h = await headers();
  redirect(sitePath("/login", h));
}

/** Signed-in user changing their own password (see /account). */
export async function updatePassword(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "The two passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };
  return { success: "Password changed. Use it the next time you sign in." };
}
