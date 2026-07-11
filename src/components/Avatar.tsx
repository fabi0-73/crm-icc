/** Shared avatar initials — consistent color from name. */
const PALETTE = [
  "bg-[#1b4d8c]",
  "bg-[#0f766e]",
  "bg-[#7c3aed]",
  "bg-[#b45309]",
  "bg-[#be123c]",
  "bg-[#0369a1]",
  "bg-[#4338ca]",
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
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dim =
    size === "sm" ? "h-9 w-9 text-xs" : size === "lg" ? "h-14 w-14 text-lg" : "h-11 w-11 text-sm";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${dim} ${avatarTone(name)} ${className}`}
      aria-hidden
    >
      {initials(name) || "·"}
    </div>
  );
}
