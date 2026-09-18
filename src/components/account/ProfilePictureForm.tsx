"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { useSetProfileAvatar } from "@/components/presence/ProfileAvatarsProvider";
import { updateMyAvatarUrl } from "@/app/actions/profile";
import {
  clearUserAvatarFiles,
  uploadUserAvatar,
  userAvatarError,
} from "@/lib/avatars";

const ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

export function ProfilePictureForm({
  userId,
  name,
  initialUrl,
}: {
  userId: string;
  name: string;
  initialUrl: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const setLive = useSetProfileAvatar();
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string | null) {
    const res = await updateMyAvatarUrl(next);
    if (res.error) {
      setError(res.error);
      return false;
    }
    setUrl(next);
    setLive(userId, next);
    router.refresh();
    return true;
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const blocked = userAvatarError(file);
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    setError(null);
    const uploaded = await uploadUserAvatar(userId, file);
    if (uploaded.error || !uploaded.url) {
      setBusy(false);
      setError(uploaded.error ?? "Could not upload the image.");
      return;
    }
    const ok = await save(uploaded.url);
    setBusy(false);
    if (!ok) return;
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    const ok = await save(null);
    if (ok) await clearUserAvatarFiles(userId);
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar name={name} size="lg" userId={userId} src={url} />
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-mist disabled:opacity-50"
          >
            {busy ? "Saving…" : url ? "Change photo" : "Upload photo"}
          </button>
          {url && (
            <button
              type="button"
              onClick={() => void onRemove()}
              disabled={busy}
              className="ml-2 text-sm text-muted hover:text-ink disabled:opacity-50"
            >
              Remove
            </button>
          )}
          <p className="mt-1 text-[12px] text-muted">
            JPG, PNG or WEBP. 2 MB or smaller.
          </p>
        </div>
      </div>
      {error && (
        <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => void onPick(e)}
      />
    </div>
  );
}
