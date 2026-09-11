"use client";

import { useEffect, useState } from "react";
import { BellRing, Share } from "lucide-react";
import { Modal } from "@/components/Modal";
import {
  ensureNotifyPermission,
  notificationPermission,
  notificationsSupported,
  registerServiceWorker,
} from "@/lib/notify";
import { savePushSubscription } from "@/lib/push/client";

const KEY = "icc.notify.prompt.v1";
/** Asked and dismissed — leave them alone for a week. */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
/** Let the app paint before asking; an instant modal reads as a pop-up ad. */
const DELAY_MS = 2500;

function snoozed(): boolean {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze() {
  try {
    window.localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* private mode — it'll ask again next session, which is fine */
  }
}

/**
 * iOS only delivers Web Push to an app that has been added to the Home
 * Screen. In a plain Safari tab the Notification API isn't even exposed, so
 * an "Enable" button would do nothing — these users need install steps
 * instead.
 */
function iosNeedsInstall(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (!/iphone|ipad|ipod/i.test(navigator.userAgent)) return false;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return !standalone;
}

/**
 * One-time nudge to turn on notifications. Browsers will not let us enable
 * them silently — permission requires a real click and the browser's own
 * prompt — so this asks in our UI first and only then triggers the native
 * prompt. That ordering matters: a native prompt the user dismisses is
 * permanent until they dig into site settings, so we never fire it blind.
 */
export function NotificationPrompt() {
  const [open, setOpen] = useState(false);
  const [needsInstall, setNeedsInstall] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (snoozed()) return;

    // iOS in a browser tab: can't subscribe at all until installed.
    if (!notificationsSupported()) {
      if (!iosNeedsInstall()) return;
      const t = setTimeout(() => {
        setNeedsInstall(true);
        setOpen(true);
      }, DELAY_MS);
      return () => clearTimeout(t);
    }

    // Already granted, or blocked (asking again can't help) — stay quiet.
    if (notificationPermission() !== "default") return;

    const t = setTimeout(() => {
      setNeedsInstall(iosNeedsInstall());
      setOpen(true);
    }, DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  function dismiss() {
    snooze();
    setOpen(false);
  }

  async function enable() {
    setBusy(true);
    try {
      const granted = await ensureNotifyPermission();
      if (granted) {
        await registerServiceWorker();
        await savePushSubscription();
      }
    } finally {
      setBusy(false);
      snooze();
      setOpen(false);
    }
  }

  return (
    <Modal title="Turn on notifications" open={open} onClose={dismiss}>
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
          {needsInstall ? (
            <Share className="size-5" />
          ) : (
            <BellRing className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {needsInstall ? (
            <>
              <p className="text-[14px] leading-relaxed text-ink">
                To get calls and messages on your iPhone, add ICC Desk to your
                Home Screen first — Apple only delivers notifications to
                installed apps.
              </p>
              <ol className="mt-2.5 space-y-1 text-[13px] text-muted">
                <li>
                  1. Tap the <span className="font-medium text-ink">Share</span>{" "}
                  button in Safari
                </li>
                <li>
                  2. Choose{" "}
                  <span className="font-medium text-ink">Add to Home Screen</span>
                </li>
                <li>3. Open ICC Desk from your Home Screen and allow notifications</li>
              </ol>
            </>
          ) : (
            <p className="text-[14px] leading-relaxed text-ink">
              Get an alert when someone calls you or sends a message — even when
              ICC Desk is closed. Calls ring; messages just chime quietly.
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="rounded-full px-4 py-2 text-[14px] font-medium text-muted hover:bg-mist"
        >
          {needsInstall ? "Got it" : "Not now"}
        </button>
        {!needsInstall && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="rounded-full bg-brand-600 px-4 py-2 text-[14px] font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Enabling…" : "Turn on"}
          </button>
        )}
      </div>
    </Modal>
  );
}
