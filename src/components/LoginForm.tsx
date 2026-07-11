"use client";

import { useActionState } from "react";
import { signIn } from "@/app/actions/auth";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

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
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={configError}
        />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={configError}
        />
      </div>
      <Button
        type="submit"
        disabled={pending || configError}
        className="w-full"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted">
        <Link href="/auth/forgot-password" className="text-brand-600 hover:underline">
          Forgot password?
        </Link>
      </p>
    </form>
  );
}
