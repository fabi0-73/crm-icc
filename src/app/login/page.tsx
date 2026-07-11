import Image from "next/image";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-mist px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Image
            src="/logo.png"
            alt="ICC"
            width={88}
            height={82}
            priority
            className="mb-3"
          />
          <h1 className="text-xl font-semibold text-ink tracking-tight">
            ICC Desk
          </h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>
        </div>
        <div className="rounded-xl bg-paper p-5 shadow-sm border border-line">
          <LoginForm
            next={params.next ?? "/rooms"}
            errorParam={params.error}
          />
        </div>
      </div>
    </div>
  );
}
