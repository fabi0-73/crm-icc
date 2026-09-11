/**
 * Shown while a conversation's server data is being fetched. Without a
 * boundary here Next keeps the previous room on screen for the whole
 * ~1–2s load, so the reader sees another chat's messages under the new
 * chat's name.
 */
export default function RoomLoading() {
  return (
    <div className="flex h-full flex-col bg-stream">
      <div className="flex shrink-0 items-center gap-2 border-b border-line/80 bg-paper/90 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-line/70" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3.5 w-40 animate-pulse rounded bg-line/70" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-line/50" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-3 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className={`flex ${i % 2 === 0 ? "justify-start" : "justify-end"}`}
            >
              <div
                className="h-12 animate-pulse rounded-2xl bg-line/60"
                style={{ width: `${45 + ((i * 13) % 30)}%` }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-line/80 bg-paper/95 px-3 py-3">
        <div className="mx-auto h-10 w-full max-w-3xl animate-pulse rounded-3xl bg-line/50" />
      </div>
    </div>
  );
}
