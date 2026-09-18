import { createClient } from "@/lib/supabase/client";

const AVATAR_BUCKET = "avatars";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;

export type AvatarUploadResult = { url?: string; error?: string };

/**
 * Upload a group image to the public `avatars` bucket and return its
 * public URL. The bucket is public-read, so the URL is stable and needs
 * no signing — it goes straight into rooms.avatar_url. Keys are random;
 * old images are left in place (cheap, and avoids a delete race).
 */
export async function uploadGroupAvatar(file: File): Promise<AvatarUploadResult> {
  if (!file.type.startsWith("image/")) {
    return { error: "Choose an image file." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { error: "Image must be 2 MB or smaller." };
  }

  const supabase = createClient();
  const ext = (file.name.split(".").pop() ?? "png")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 5) || "png";
  const key = `groups/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(key, file, { cacheControl: "3600", upsert: false });
  if (error) return { error: error.message };

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(key);
  return { url: data.publicUrl };
}

/** Shared validation so the picker can reject before any upload starts. */
export function userAvatarError(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file.";
  if (file.size > MAX_AVATAR_BYTES) return "Image must be 2 MB or smaller.";
  return null;
}

/**
 * Upload one person's profile picture. Keyed by user id so storage
 * policy can restrict writes to the owner's own folder; the resulting
 * public URL goes into profiles.avatar_url and is readable by everyone.
 */
export async function uploadUserAvatar(
  userId: string,
  file: File,
): Promise<AvatarUploadResult> {
  const blocked = userAvatarError(file);
  if (blocked) return { error: blocked };

  const supabase = createClient();
  const ext = (file.name.split(".").pop() ?? "png")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 5) || "png";
  const key = `users/${userId}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(key, file, { cacheControl: "3600", upsert: false });
  if (error) return { error: error.message };

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(key);
  return { url: data.publicUrl };
}

/** Best-effort cleanup of a person's old uploads after they remove it. */
export async function clearUserAvatarFiles(userId: string): Promise<void> {
  const supabase = createClient();
  const prefix = `users/${userId}`;
  const { data } = await supabase.storage.from(AVATAR_BUCKET).list(prefix);
  const keys = (data ?? []).map((f) => `${prefix}/${f.name}`);
  if (keys.length) await supabase.storage.from(AVATAR_BUCKET).remove(keys);
}

/**
 * Upload a group's chat wallpaper. Same public bucket, its own prefix,
 * and a larger ceiling than avatars because it is shown full-bleed.
 */
export async function uploadGroupBackground(
  roomId: string,
  file: File,
): Promise<AvatarUploadResult> {
  if (!file.type.startsWith("image/")) {
    return { error: "Choose an image file." };
  }
  if (file.size > MAX_BACKGROUND_BYTES) {
    return { error: "Image must be 5 MB or smaller." };
  }

  const supabase = createClient();
  const ext = (file.name.split(".").pop() ?? "png")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 5) || "png";
  const key = `groups/backgrounds/${roomId}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(key, file, { cacheControl: "3600", upsert: false });
  if (error) return { error: error.message };

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(key);
  return { url: data.publicUrl };
}
