"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/uikit/drawer";

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

/** App dialog: swipeable bottom drawer on phones, centered panel on
 *  desktop. Same `title/open/onClose/children` contract everywhere. */
export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const mobile = useIsMobile();
  // Portal target. Until mounted this is null and the desktop branch
  // renders nothing (the mobile Drawer portals itself), which is correct
  // for SSR and the first paint.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mobile, onClose]);

  if (mobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        showSwipeHandle
      >
        <DrawerContent className="bg-paper">
          <DrawerHeader className="pb-2">
            <DrawerTitle className="text-[16px] font-semibold text-ink">
              {title}
            </DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  if (!open || !mounted) return null;

  // Portalled to <body>: rendered inline, the panel sat inside the
  // sidebar's dark, `text-white` stacking context, so its contents drew
  // white-on-white (the "invisible text" when creating a group) and the
  // panel layered beneath fixed app overlays. At the body root it owns a
  // clean context and inherits the app's default ink text colour.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 text-ink">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 w-full max-w-md rounded-2xl bg-paper shadow-lift max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted hover:bg-mist hover:text-ink"
          >
            Close
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function useModal(initial = false) {
  const [open, setOpen] = useState(initial);
  return {
    open,
    openModal: () => setOpen(true),
    closeModal: () => setOpen(false),
    setOpen,
  };
}
