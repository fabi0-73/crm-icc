import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { CallProvider } from "@/components/call/CallProvider";
import { requireProfile } from "@/lib/auth";
import { sitePath } from "@/lib/site-url";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const { profile } = await requireProfile();
    // CallProvider wraps BOTH branches so incoming calls ring on every
    // page — including for agents, who skip the chrome nav.
    if (profile.role === "agent") {
      return (
        <CallProvider userId={profile.id} userName={profile.full_name}>
          <div className="h-dvh">{children}</div>
        </CallProvider>
      );
    }
    return (
      <CallProvider userId={profile.id} userName={profile.full_name}>
        <AppShell profile={profile}>{children}</AppShell>
      </CallProvider>
    );
  } catch {
    const h = await headers();
    redirect(sitePath("/login", h));
  }
}
