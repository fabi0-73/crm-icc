"use client";

import { useActionState } from "react";
import { signIn } from "@/app/actions/auth";
import Link from "next/link";

const ERROR_MESSAGES: Record<string, string> = {
  deactivated: "This account has been deactivated.",
  config:
    "Supabase is not configured. Edit .env.local with your project URL and anon key from the Supabase dashboard (Settings → API), then restart npm run dev.",
  auth: "Authentication link expired or invalid. Try signing in again.",
};

export function LoginForm({
  next,
  errorParam,
}: {
  next: string;
  errorParam?: string;
}) {
  const [state, action, pending] = useActionState(signIn, {});
  const configError = errorParam === "config";
  const banner =
    state.error ?? (errorParam ? ERROR_MESSAGES[errorParam] : undefined);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      {banner && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {banner}
        </p>
      )}
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={configError}
          className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-mist"
      />
      </div>
      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-ink"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={configError}
          className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-mist"
        />
      </div>
      <button
        type="submit"
        disabled={pending || configError}
        className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-muted">
        <Link href="/auth/forgot-password" className="text-brand-600 hover:underline">
          Forgot password?
        </Link>
      </p>
    </form>
  );
}
