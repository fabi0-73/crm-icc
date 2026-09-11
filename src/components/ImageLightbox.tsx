"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

/**
 * Full-screen in-app image viewer. Opening an image used to navigate the tab
 * to the raw signed storage URL ("opening an image redirects to another
 * page"); this keeps the user in the conversation instead. Closes on the X,
 * a backdrop click, or Escape.
 */
export function ImageLightbox({
  src,
  name,
  onClose,
}: {
  src: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Don't let the chat scroll behind the overlay.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/80 p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <X className="size-5" />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element -- signed
          Supabase URLs are short-lived; next/image can't optimize them */}
      <img
        src={src}
        alt={name}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />

      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/20"
      >
        Open original
      </a>
    </div>
  );
}
