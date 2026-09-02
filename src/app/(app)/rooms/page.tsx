import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireProfile } from "@/lib/auth";
import { MobileChatsScreen } from "@/components/rooms/MobileChatsScreen";
import { sitePath } from "@/lib/site-url";

export default async function RoomsPage() {
  const { supabase, profile } = await requireProfile();

  if (profile.role === "agent") {
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", profile.id)
      .maybeSingle();
    if (agent) {
      const { data: room } = await supabase
        .from("rooms")
        .select("id")
        .eq("agent_id", agent.id)
        .eq("type", "agent_workspace")
        .maybeSingle();
      if (room) {
        const h = await headers();
        redirect(sitePath(`/rooms/${room.id}`, h));
      }
    }
    // Agents have no sidebar and no RoomsProvider — the staff screens
    // below would crash for them.
    return (
      <div className="flex h-app flex-col items-center justify-center gap-4 bg-stream px-6 text-center">
        <div>
          <p className="text-[16px] font-semibold text-ink">
            No workspace yet
          </p>
          <p className="mt-1 text-[13px] text-muted">
            Your account isn&rsquo;t linked to a workspace. Ask your contact at
            ICC to set it up.
          </p>
        </div>
        <Link
          href="/account"
          className="inline-flex h-9 items-center rounded-lg border border-line bg-paper px-3.5 text-[13px] font-medium text-ink shadow-xs"
        >
          Your account
        </Link>
      </div>
    );
  }

  const canCreateGroup =
    profile.role === "admin" || profile.role === "manager";

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
