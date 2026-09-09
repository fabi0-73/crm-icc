"use client";

import { useActionState } from "react";
import { signIn } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

const ERROR_MESSAGES: Record<string, string> = {
  deactivated:
    "This account has been deactivated. Ask an admin to restore it.",
  config:
    "Supabase is not configured. Edit .env.local with your project URL and anon key from the Supabase dashboard (Settings → API), then restart npm run dev.",
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
        <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {banner}
        </p>
      )}
      <div>
        <Label htmlFor="identifier">Username</Label>
        <Input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Your username or email"
          className="py-3 text-[16px]"
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
          className="py-3 text-[16px]"
          required
          disabled={configError}
        />
      </div>
      <Button
        type="submit"
        disabled={pending || configError}
        className="h-11 w-full rounded-xl text-[15px]"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
