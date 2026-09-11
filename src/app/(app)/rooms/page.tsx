import { requireProfile } from "@/lib/auth";
import { MobileChatsScreen } from "@/components/rooms/MobileChatsScreen";

export default async function RoomsPage() {
  const { profile } = await requireProfile();

  // Agents now share the dashboard too (they have the sidebar + RoomsProvider),
  // so no special-case redirect — their workspace + DMs list here like anyone's.
  const canCreateGroup =
    profile.role === "admin" ||
    profile.role === "manager" ||
    profile.role === "assistant";

  return (
    <>
      {/* Mobile: the full chats home (live via RoomsProvider). */}
      <div className="h-full sm:hidden">
        <MobileChatsScreen canCreateGroup={canCreateGroup} />
      </div>
      {/* Desktop: the sidebar already lists everything. */}
      <div className="hidden h-full items-center justify-center bg-stream sm:flex">
        <div className="flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-brand-600 shadow-soft ring-1 ring-line/60">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <p className="text-[15px] font-semibold text-ink">
            Select a conversation
          </p>
          <p className="mt-1 text-[13px] text-muted">
            Pick a channel or direct message from the sidebar.
          </p>
        </div>
      </div>
    </>
  );
}
