"use client";

import { FileText, X } from "lucide-react";

export type StagedItem = {
  /** Stable key for React + removal. */
  id: string;
  file: File;
  /** Object URL for image previews; null for non-images. */
  url: string | null;
};

function formatBytes(n: number) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Preview strip for one-or-more picked-but-unsent files. Images show a
 * thumbnail, everything else a labeled chip; each is individually
 * removable. The composer textarea doubles as the shared caption. Object
 * URLs are created and revoked by the caller.
 */
export function StagedAttachments({
  items,
  onRemove,
}: {
  items: StagedItem[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2">
      {items.map((it) =>
        it.url ? (
          <div
            key={it.id}
            className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line/80 bg-secondary"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
            <img
              src={it.url}
              alt={it.file.name}
              className="h-full w-full object-cover"
            />
            <button
              type="button"
              onClick={() => onRemove(it.id)}
              aria-label={`Remove ${it.file.name}`}
              className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink/70 text-white hover:bg-ink"
            >
              <X className="size-[14px]" />
            </button>
          </div>
        ) : (
          <div
            key={it.id}
            className="flex max-w-[220px] items-center gap-2 rounded-xl border border-line/80 bg-secondary px-2.5 py-2"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <FileText className="size-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-ink">
                {it.file.name}
              </span>
              <span className="block text-[11px] text-muted">
                {formatBytes(it.file.size) || "Ready to send"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onRemove(it.id)}
              aria-label={`Remove ${it.file.name}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist"
            >
              <X className="size-[16px]" />
            </button>
          </div>
        ),
      )}
    </div>
  );
}
