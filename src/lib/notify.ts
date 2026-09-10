"use client";

/**
 * Desktop / mobile pop-up notifications via the Web Notifications API.
 * Shared by the message layer (RoomsProvider) and the call layer
 * (CallProvider) so a new message or an incoming call can surface even
 * when the relevant chat is not on screen — another section of the app,
 * a background tab, or a phone with the PWA open.
 *
 * This module handles the FOREGROUND case (some app tab is alive). True
 * delivery to a fully-closed app is Web Push and is layered on top by
 * registerPush() when the server is configured for it.
 */

type NotifyOptions = {
  title: string;
  body?: string;
  /** Collapses repeats (e.g. one tag per room or per call). */
  tag?: string;
  /** Focus/navigate here when the notification is clicked. */
  url?: string;
  /** Bypass the "only when not focused" guard (calls always alert). */
  force?: boolean;
};

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission {
  if (!notificationsSupported()) return "denied";
  return Notification.permission;
}

/** Ask once; resolves to true when granted. Safe to call repeatedly. */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const res = await Notification.requestPermission();
    return res === "granted";
  } catch {
    return false;
  }
}

/**
 * Show a notification if allowed. No-op when unsupported, not granted, or
 * (for non-forced notifications) when the page is actually focused — a
 * message you're already looking at shouldn't pop. Never throws.
 */
export function notify(opts: NotifyOptions): void {
  try {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    const focused =
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      document.hasFocus();
    if (focused && !opts.force) return;

    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: "/icons/icon-192.webp",
      badge: "/icons/icon-96.webp",
    });
    if (opts.url) {
      n.onclick = () => {
        try {
          window.focus();
          window.location.href = opts.url as string;
        } catch {
          /* ignore */
        }
        n.close();
      };
    }
  } catch {
    /* notifications are best-effort */
  }
}

/**
 * Register the service worker (needed for Web Push and for notification-click
 * routing that outlives the page). Best-effort; returns the registration or
 * null. Reuses an existing registration so repeated calls are cheap.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration("/");
    if (existing) return existing;
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/** Decode a base64url VAPID public key into the bytes subscribe() expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Web Push subscription scaffold.
 *
 * IF a VAPID public key is exposed at NEXT_PUBLIC_VAPID_PUBLIC_KEY, subscribe
 * this browser via the service worker's push manager and return the
 * subscription. If the env var is absent (the default — no server push is
 * configured), this is a deliberate no-op that returns null, so nothing breaks
 * without server config.
 *
 * OUT OF SCOPE (server side): closed-app delivery still needs a VAPID *sender*.
 * The returned subscription (`sub.toJSON()`) must be POSTed to a server that
 * stores it and, using the VAPID PRIVATE key, sends push messages shaped as
 * { title, body, url, tag } — the payload public/sw.js's `push` handler reads.
 * Foreground pop-ups (notify()) do NOT depend on any of this.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) return null; // no server push configured → no-op

  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (typeof window === "undefined" || !("PushManager" in window)) return null;
  if (!notificationsSupported() || Notification.permission !== "granted") return null;

  try {
    const registration = await registerServiceWorker();
    if (!registration) return null;
    // Ensure a worker is active before touching pushManager.
    await navigator.serviceWorker.ready;

    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;

    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  } catch {
    // Subscription is best-effort; foreground notifications are unaffected.
    return null;
  }
}
