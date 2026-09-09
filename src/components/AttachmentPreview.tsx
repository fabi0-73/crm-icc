"use client";

import { FileText, X } from "lucide-react";

function formatBytes(n: number) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Confirmation card for a file that has been picked but not yet sent.
 * The composer's textarea doubles as the optional caption while this is
 * shown. Images get a thumbnail from an object URL created by the caller
 * (who is also responsible for revoking it).
 */
export function AttachmentPreview({
  file,
  previewUrl,
  onCancel,
}: {
  file: File;
  previewUrl: string | null;
  onCancel: () => void;
}) {
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-3 rounded-2xl border border-line/80 bg-secondary px-3 py-2.5">
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
        <img
          src={previewUrl}
          alt={file.name}
          className="h-14 w-14 shrink-0 rounded-xl object-cover"
        />
      ) : (
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <FileText className="size-6" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-ink">{file.name}</p>
        <p className="text-[12px] text-muted">
          {formatBytes(file.size) || "Ready to send"}
        </p>
      </div>

      <button
        type="button"
        onClick={onCancel}
        aria-label="Remove attachment"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist active:bg-mist"
      >
        <X className="size-[18px]" />
      </button>
    </div>
  );
}
