import { ForgotPasswordForm } from "@/components/PasswordForms";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-hero px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-paper p-6 shadow-lift">
        <h1 className="mb-4 text-center text-lg font-bold tracking-tight text-ink">
          Reset password
        </h1>
        <ForgotPasswordForm />
      </div>
    </div>
  );
}
