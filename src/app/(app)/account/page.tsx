import Link from "next/link";
import { ChevronLeft, LogOut } from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { signOut } from "@/app/actions/auth";
import { emailToUsername } from "@/lib/username";
import { ChangePasswordForm } from "@/components/PasswordForms";
import { DisplayNameForm } from "@/components/DisplayNameForm";
import { NotificationSettings } from "@/components/NotificationSettings";
import { ProfilePictureForm } from "@/components/account/ProfilePictureForm";
import { PublicNameForm } from "@/components/account/PublicNameForm";
import { publicDisplayName } from "@/lib/display-name";

/** Every role reaches this page — it is the only sign-out and
 *  password-change surface an agent has. */
export default async function AccountPage() {
  const { user, profile } = await requireProfile();
  const username = emailToUsername(user.email ?? "");
  const shown = publicDisplayName(profile);
  // Assistants and agents get a chat-facing name on top of their account
  // name; admins and managers are always shown by their account name.
  const hasPublicName = profile.role === "assistant" || profile.role === "agent";

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
        <div className="rounded-2xl border border-line bg-paper p-4 shadow-xs">
          <div className="mb-3 min-w-0">
            <p className="truncate text-[15px] font-semibold text-ink">
              {shown}
            </p>
            {shown !== profile.full_name && (
              <p className="truncate text-[12px] text-muted">
                Account name: {profile.full_name}
              </p>
            )}
            <p className="truncate font-mono text-[13px] text-muted">
              {username}
            </p>
            <p className="text-[12px] capitalize text-muted">{profile.role}</p>
          </div>
          <ProfilePictureForm
            userId={profile.id}
            name={shown}
            initialUrl={profile.avatar_url ?? null}
          />
        </div>

        <div className="rounded-2xl border border-line bg-paper p-4 shadow-xs">
          <h2 className="mb-1 text-[15px] font-semibold text-ink">
            Display name
          </h2>
          {hasPublicName ? (
            <>
              <p className="mb-3 text-[13px] text-muted">
                The name people see in chats and calls. Your account name,
                login and role stay the same.
              </p>
              <PublicNameForm
                fullName={profile.full_name}
                publicName={profile.public_name ?? null}
              />
            </>
          ) : (
            <>
              <p className="mb-3 text-[13px] text-muted">
                Change the name other people see across the app.
              </p>
              <DisplayNameForm initialName={profile.full_name} />
            </>
          )}
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
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400">
              <LogOut className="size-[18px]" />
            </span>
            <span className="text-[15px] font-medium text-red-600 dark:text-red-400">
              Sign out
            </span>
          </button>
        </form>
      </div>
    </div>
  );
}
