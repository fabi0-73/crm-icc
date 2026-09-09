"use client";

import { useEffect, useRef, useState } from "react";
import { CornerUpLeft, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

/**
 * The hover/tap "⋯" affordance on a message bubble. On desktop it fades
 * in on hover of the surrounding `.group`; on mobile it is always tappable.
 * Delete asks for confirmation inline rather than through a browser dialog.
 */
export function MessageActions({
  align,
  canReply,
  canEdit,
  canDelete,
  onReply,
  onEdit,
  onDelete,
}: {
  /** Which side of the bubble the button sits on. */
  align: "left" | "right";
  canReply: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!canReply && !canEdit && !canDelete) return null;

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted opacity-100 hover:bg-mist active:bg-mist sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        <MoreHorizontal className="size-[18px]" />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute bottom-full z-30 mb-1 w-40 overflow-hidden rounded-xl border border-line/80 bg-paper py-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {canReply && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onReply();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-ink hover:bg-mist"
            >
              <CornerUpLeft className="size-[16px] text-muted" />
              Reply
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onEdit();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-ink hover:bg-mist"
            >
              <Pencil className="size-[16px] text-muted" />
              Edit
            </button>
          )}
          {canDelete &&
            (confirming ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onDelete();
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] font-medium text-red-600 hover:bg-red-50"
              >
                <Trash2 className="size-[16px]" />
                Delete for sure?
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirming(true)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-red-600 hover:bg-red-50"
              >
                <Trash2 className="size-[16px]" />
                Delete
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
