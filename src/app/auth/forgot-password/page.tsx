import { ForgotPasswordForm } from "@/components/PasswordForms";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-mist px-4">
      <div className="w-full max-w-sm rounded-xl bg-paper p-6 shadow-sm border border-line">
        <h1 className="mb-4 text-center text-lg font-semibold text-ink">
          Reset password
        </h1>
        <ForgotPasswordForm />
      </div>
    </div>
  );
}
