"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Full-size preview shown over the chat instead of a new browser tab.
 * Portalled to <body> so the message list's scroll container and the
 * bubble's rounded overflow clipping can't cut the image off.
 */
export function ImageLightbox({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-[110] flex items-center justify-center overscroll-contain bg-ink/90 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
    >
      <button
        type="button"
        aria-label="Close image"
        className="absolute inset-0 cursor-zoom-out"
        onClick={onClose}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
      >
        <X className="size-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed
          Supabase URLs are short-lived; next/image can't optimize them */}
      <img
        src={url}
        alt={name}
        className="relative max-h-full max-w-full object-contain"
      />
    </div>,
    document.body,
  );
}
