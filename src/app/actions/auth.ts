"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getSiteOrigin, sitePath } from "@/lib/site-url";

export type AuthState = { error?: string; success?: string };

/** Bare usernames sign in as <name>@USERNAME_DOMAIN under the hood;
 *  full email addresses keep working unchanged. */
const USERNAME_DOMAIN = "iccdesk.duckdns.org";

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

  const email = identifier.includes("@")
    ? identifier
    : `${identifier}@${USERNAME_DOMAIN}`;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
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
      await supabase.auth.signOut();
      return { error: "This account has been deactivated." };
    }
  }

  const h = await headers();
  const dest = next.startsWith("/") ? next : "/rooms";
  redirect(sitePath(dest, h));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const h = await headers();
  redirect(sitePath("/login", h));
}

export async function requestPasswordReset(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Email is required." };

  const supabase = await createClient();
  const h = await headers();
  const siteUrl = getSiteOrigin(h);
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl}/auth/reset-password`,
  });
  if (error) return { error: error.message };
  return { success: "Check your email for a reset link." };
}

export async function updatePassword(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };
  const h = await headers();
  redirect(sitePath("/rooms", h));
}
