import { createClient } from "@/lib/supabase/client";

const AVATAR_BUCKET = "avatars";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const USER_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const USER_AVATAR_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);

export type AvatarUploadResult = { url?: string; error?: string };

function avatarExt(file: File) {
  const fromName = (file.name.split(".").pop() ?? "").toLowerCase();
  if (USER_AVATAR_EXTS.has(fromName)) return fromName === "jpeg" ? "jpg" : fromName;
  if (file.type === "image/jpeg") return "jpg";
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "";
}

/** JPG, PNG or WEBP, 2 MB or smaller. Same limit as the avatars bucket. */
export function userAvatarError(file: File): string | null {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const typeOk = USER_AVATAR_TYPES.has(file.type);
  const extOk = USER_AVATAR_EXTS.has(ext);
  if (!typeOk && !extOk) {
    return "Use a JPG, PNG, or WEBP image.";
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return "Image must be 2 MB or smaller.";
  }
  return null;
}

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

/**
 * Upload a profile picture under avatars/users/{userId}/. The public
 * URL is stable; the caller writes it onto profiles.avatar_url.
 */
export async function uploadUserAvatar(
  userId: string,
  file: File,
): Promise<AvatarUploadResult> {
  const blocked = userAvatarError(file);
  if (blocked) return { error: blocked };

  const supabase = createClient();
  const ext = avatarExt(file) || "jpg";
  const key = `users/${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(key, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
  });
  if (error) return { error: error.message };

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(key);
  return { url: data.publicUrl };
}

/** Best-effort cleanup of this user's previous profile objects. */
export async function clearUserAvatarFiles(userId: string) {
  const supabase = createClient();
  const folder = `users/${userId}`;
  const { data } = await supabase.storage.from(AVATAR_BUCKET).list(folder);
  const names = (data ?? []).map((f) => `${folder}/${f.name}`);
  if (names.length === 0) return;
  await supabase.storage.from(AVATAR_BUCKET).remove(names);
}
