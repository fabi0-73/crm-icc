"use client";

import { useEffect, useState } from "react";
import { useProfileAvatar } from "@/components/presence/ProfileAvatarsProvider";

/** Shared avatar initials — consistent color from name.
 *  Cool corporate family only, so avatars read as one system. */
const PALETTE = [
  "bg-[#1d4ed8]", // blue-700
  "bg-[#0e7490]", // cyan-700
  "bg-[#4f46e5]", // indigo-600
  "bg-[#7c3aed]", // violet-600
  "bg-[#0369a1]", // sky-700
  "bg-[#475569]", // slate-600
  "bg-[#1e3a8a]", // blue-900
];

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function avatarTone(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i) * 17) % PALETTE.length;
  return PALETTE[h];
}

function Initials({
  name,
  dim,
  className,
}: {
  name: string;
  dim: string;
  className: string;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${dim} ${avatarTone(name)} ${className}`}
      aria-hidden
    >
      {initials(name) || "·"}
    </div>
  );
}

export function Avatar({
  name,
  size = "md",
  className = "",
  src,
  userId = null,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Explicit image (group avatars, or a known profile URL). */
  src?: string | null;
  /** When set, the live profile-picture map wins over `src`. */
  userId?: string | null;
}) {
  const live = useProfileAvatar(userId, src);
  const picture = userId ? live : (src ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [picture]);

  const dim =
    size === "sm" ? "h-9 w-9 text-xs" : size === "lg" ? "h-14 w-14 text-lg" : "h-11 w-11 text-sm";

  if (picture && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- public bucket
      // URL, not a Next-optimizable asset
      <img
        src={picture}
        alt={name}
        onError={() => setBroken(true)}
        className={`shrink-0 rounded-full object-cover ${dim} ${className}`}
      />
    );
  }
  return <Initials name={name} dim={dim} className={className} />;
}
