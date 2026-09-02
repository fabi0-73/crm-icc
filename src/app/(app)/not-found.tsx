import Link from "next/link";

export default function AppNotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-stream px-6 text-center">
      <div>
        <p className="text-[17px] font-semibold text-ink">Not found</p>
        <p className="mt-1 text-[13px] text-muted">
          This conversation or page doesn&rsquo;t exist, or you&rsquo;re not a
          member of it.
        </p>
      </div>
      <Link
        href="/rooms"
        className="inline-flex h-9 items-center rounded-lg bg-brand-grad px-3.5 text-[13px] font-semibold text-white shadow-brand"
      >
        Go to chats
      </Link>
    </div>
  );
}
