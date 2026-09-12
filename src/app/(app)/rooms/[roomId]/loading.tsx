/**
 * Shown while a conversation is being fetched.
 *
 * Without a loading boundary scoped to this route, the nearest one is the
 * whole (app) segment — so switching rooms either blanked the entire shell or
 * left the PREVIOUS conversation on screen for the 0.8–2.3s the new one took
 * to arrive, which reads as "the app is showing me the wrong chat". This
 * keeps the chrome in place and makes it obvious the room is loading.
 */
export default function RoomLoading() {
  return (
    <div className="flex h-full flex-col bg-stream">
      {/* Header placeholder */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-paper px-4 py-3">
        <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-line/70" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3.5 w-40 animate-pulse rounded bg-line/70" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-line/50" />
        </div>
      </div>

      {/* A few message-shaped placeholders, alternating sides. */}
      <div className="flex-1 space-y-4 overflow-hidden p-4">
        {[
          { mine: false, w: "w-52" },
          { mine: true, w: "w-40" },
          { mine: false, w: "w-64" },
          { mine: false, w: "w-36" },
          { mine: true, w: "w-56" },
        ].map((row, i) => (
          <div
            key={i}
            className={`flex ${row.mine ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`h-10 ${row.w} max-w-[70%] animate-pulse rounded-2xl ${
                row.mine ? "bg-brand-200/60" : "bg-line/70"
              }`}
            />
          </div>
        ))}
      </div>

      {/* Composer placeholder */}
      <div className="shrink-0 border-t border-line/80 bg-paper px-3 py-3">
        <div className="h-10 w-full animate-pulse rounded-full bg-line/60" />
      </div>
    </div>
  );
}
