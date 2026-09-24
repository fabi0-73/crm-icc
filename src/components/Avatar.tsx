"use client";

import { useEffect, useState } from "react";
import { useProfileAvatar } from "@/components/presence/ProfileAvatarsProvider";

/** Shared avatar initials — a consistent tone from the name.
 *  Four tones, all drawn from the palette, so a wall of initials reads as
 *  one system rather than a lottery of blues and violets. Each is deep
 *  enough for white initials in both modes. */
const PALETTE = [
  "bg-[#19737e]", // brand-700
  "bg-[#114950]", // brand-900
  "bg-[#4a4d55]", // graphite
  "bg-[#2f4f55]", // slate-teal
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
  src = null,
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
  const picture = userId ? live : src;
  // A deleted or replaced upload must not leave a broken image icon
  // where initials would do.
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
