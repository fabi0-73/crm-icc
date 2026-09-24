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
          {/* The ICC mark is a 3D render on an opaque white ground; on this
              charcoal page it read as a sticker. The monogram matches the
              sidebar, and the mark stays as the home-screen icon. */}
          <div
            className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-brand-600 text-[20px] font-bold tracking-tight text-white"
            aria-hidden
          >
            ICC
          </div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">
            ICC Desk
          </h1>
          <p className="mt-1 text-sm text-white/60">
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

      <p className="mt-10 text-center text-[12px] text-white/45">
        Internal messaging for agent support teams
      </p>
    </div>
  );
}
