import Image from "next/image";
import { LoginForm } from "@/components/LoginForm";
import { ClearBadge } from "@/components/ClearBadge";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-hero px-4 py-10">
      <ClearBadge />
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 rounded-2xl bg-white p-2 shadow-lift">
            <Image
              src="/logo.png"
              alt="ICC"
              width={64}
              height={60}
              priority
              className="rounded-xl"
            />
          </div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">
            ICC Desk
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Your team&rsquo;s conversations, in one place.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-paper p-6 shadow-lift">
          <LoginForm next={params.next ?? "/rooms"} errorParam={params.error} />
        </div>

        <p className="mt-5 text-center text-sm text-white/50">
          Forgot your password? Ask an admin to reset it.
        </p>
      </div>

      <p className="mt-10 text-center text-[12px] text-white/30">
        Internal messaging for agent support teams
      </p>
    </div>
  );
}
