"use client";

const PERMISSION_ASKED = "icc-notify-asked";

export function requestDesktopNotifications() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  try {
    if (sessionStorage.getItem(PERMISSION_ASKED)) return;
    sessionStorage.setItem(PERMISSION_ASKED, "1");
  } catch {
    /* ignore */
  }
  void Notification.requestPermission().catch(() => undefined);
}

export function showDesktopNotification(
  title: string,
  body: string,
  opts?: { tag?: string; silent?: boolean },
) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      tag: opts?.tag,
      silent: opts?.silent ?? false,
      icon: "/icons/icon-192.webp",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* WebView may reject; in-app UI still handles the event. */
  }
}
