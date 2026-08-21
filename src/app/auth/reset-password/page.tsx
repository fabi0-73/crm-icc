import { ResetPasswordForm } from "@/components/PasswordForms";

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-hero px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-paper p-6 shadow-lift">
        <h1 className="mb-4 text-center text-lg font-bold tracking-tight text-ink">
          Choose a password
        </h1>
        <p className="mb-4 text-center text-sm text-muted">
          Set a password for your ICC account.
        </p>
        <ResetPasswordForm />
      </div>
    </div>
  );
}
