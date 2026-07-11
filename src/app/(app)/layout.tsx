import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { requireProfile } from "@/lib/auth";
import { sitePath } from "@/lib/site-url";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const { profile } = await requireProfile();
    // Agents skip the chrome nav — they live in one room.
    if (profile.role === "agent") {
      return <div className="h-dvh">{children}</div>;
    }
    return <AppShell profile={profile}>{children}</AppShell>;
  } catch {
    const h = await headers();
    redirect(sitePath("/login", h));
  }
}
