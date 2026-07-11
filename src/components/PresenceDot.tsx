/** Online indicator. Green is a universal presence convention —
 *  the one deliberate non-token color. `ring` should match the
 *  surface it sits on (ring-paper / ring-mist). */
export function PresenceDot({
  online,
  className = "",
}: {
  online: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        online ? "bg-emerald-500" : "bg-line-strong"
      } ${className}`}
    />
  );
}
