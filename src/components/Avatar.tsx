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

export function Avatar({
  name,
  size = "md",
  className = "",
  src = null,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** When set, show this image instead of initials (group avatars). */
  src?: string | null;
}) {
  const dim =
    size === "sm" ? "h-9 w-9 text-xs" : size === "lg" ? "h-14 w-14 text-lg" : "h-11 w-11 text-sm";
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- public bucket
      // URL, not a Next-optimizable asset
      <img
        src={src}
        alt={name}
        className={`shrink-0 rounded-full object-cover ${dim} ${className}`}
      />
    );
  }
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${dim} ${avatarTone(name)} ${className}`}
      aria-hidden
    >
      {initials(name) || "·"}
    </div>
  );
}
