import { createClient } from "@/lib/supabase/client";

const AVATAR_BUCKET = "avatars";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

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
