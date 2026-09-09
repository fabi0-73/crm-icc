import Link from "next/link";
import { ChevronLeft, LogOut } from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { signOut } from "@/app/actions/auth";
import { emailToUsername } from "@/lib/username";
import { ChangePasswordForm } from "@/components/PasswordForms";
import { NotificationSettings } from "@/components/NotificationSettings";
import { Avatar } from "@/components/Avatar";

/** Every role reaches this page — it is the only sign-out and
 *  password-change surface an agent has. */
export default async function AccountPage() {
  const { user, profile } = await requireProfile();
  const username = emailToUsername(user.email ?? "");

  return (
    <div className="h-full overflow-y-auto bg-mist">
      <div className="flex items-center gap-1.5 border-b border-line bg-paper px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-4">
        <Link
          href="/rooms"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink active:bg-mist"
          aria-label="Back to chats"
        >
          <ChevronLeft className="size-6" />
        </Link>
        <h1 className="text-[17px] font-semibold text-ink">Your account</h1>
      </div>

      <div className="mx-auto w-full max-w-md space-y-4 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper p-4 shadow-xs">
          <Avatar name={profile.full_name} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-ink">
              {profile.full_name}
            </p>
            <p className="truncate font-mono text-[13px] text-muted">
              {username}
            </p>
            <p className="text-[12px] capitalize text-muted">{profile.role}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-paper p-4 shadow-xs">
          <h2 className="mb-1 text-[15px] font-semibold text-ink">
            Change password
          </h2>
          <p className="mb-4 text-[13px] text-muted">
            Pick something only you know. If you forget it, an admin can set a
            new one for you.
          </p>
          <ChangePasswordForm />
        </div>

        <NotificationSettings />

        <form action={signOut}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3.5 text-left shadow-xs active:bg-mist"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
              <LogOut className="size-[18px]" />
            </span>
            <span className="text-[15px] font-medium text-red-600">
              Sign out
            </span>
          </button>
        </form>
      </div>
    </div>
  );
}
