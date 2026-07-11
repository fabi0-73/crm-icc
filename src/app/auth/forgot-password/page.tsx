import { ForgotPasswordForm } from "@/components/PasswordForms";

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-brand-50 to-gray-100 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
        <h1 className="mb-4 text-center text-lg font-semibold text-gray-900">
          Reset password
        </h1>
        <ForgotPasswordForm />
      </div>
    </div>
  );
}
