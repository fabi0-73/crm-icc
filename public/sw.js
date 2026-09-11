/*
 * ICC Desk service worker.
 *
 * Scope of this file:
 *  - notificationclick: focus an existing app window on the target URL, or
 *    open a new one.
 *  - push: when a Web Push arrives, show a notification from the JSON payload
 *    { title, body, url, tag }. Safe no-op if the push carries no data.
 *
 * IMPORTANT: Foreground pop-ups (the notify() calls made by the message/call
 * layers) use the Notifications API directly and do NOT depend on this worker
 * or on Web Push. This worker only adds click routing and readiness for Web
 * Push. Actual delivery to a fully-closed app additionally requires a
 * server-side VAPID sender that stores subscriptions and POSTs the payloads
 * above — that server piece is out of scope here. Until it exists, the `push`
 * handler simply never fires, and everything else keeps working.
 */

/** How long a call notification may sit on a closed device before it expires.
 *  Matches the caller-side ring window, so a missed call stops nagging. */
const CALL_NOTIFICATION_TTL_MS = 65000;

self.addEventListener("install", () => {
  // Activate this version without waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Show a notification from a pushed payload. Never throws.
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_) {
      try {
        data = { body: event.data.text() };
      } catch (_) {
        data = {};
      }
    }
  }

  const isCall = Boolean(data && data.type === "call");
  const title = (data && data.title) || "ICC Desk";
  const tag = (data && data.tag ? String(data.tag) : null) || (isCall ? "call" : undefined);
  const options = {
    body: data && data.body ? String(data.body) : undefined,
    tag: tag,
    icon: "/icons/icon-192.webp",
    badge: "/icons/icon-96.webp",
    // A call should stay on screen and buzz until it is dealt with. A message
    // is a quiet one-shot that never nags.
    renotify: isCall,
    requireInteraction: isCall,
    vibrate: isCall ? [600, 250, 600, 250, 600] : undefined,
    data: { url: (data && data.url) || "/", type: isCall ? "call" : "message" },
  };

  event.waitUntil(
    (async () => {
      // If ANY app window is open — even a background tab — the running app
      // already rings/chimes through its own layer. Showing a push on top of
      // that is what produced the double alert. Only a fully closed app needs
      // this notification.
      try {
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        if (windows.length > 0) return;
      } catch (_) {
        /* fall through and show */
      }

      await self.registration.showNotification(title, options);

      // Nobody is running to cancel a missed call's notification when the app
      // is closed, so expire it with the ring window instead of leaving an
      // "Incoming call" sitting on the lock screen forever.
      if (isCall) {
        await new Promise((resolve) =>
          setTimeout(resolve, CALL_NOTIFICATION_TTL_MS),
        );
        try {
          const open = await self.registration.getNotifications({ tag: tag });
          open.forEach((n) => n.close());
        } catch (_) {
          /* ignore */
        }
      }
    })(),
  );
});

// Focus/open the app on the notification's URL when clicked.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Prefer an already-open window; navigate it if it isn't there yet.
        for (const client of clientList) {
          try {
            const url = new URL(client.url);
            const path = url.pathname + url.search;
            if (path === targetUrl || client.url === targetUrl) {
              return client.focus();
            }
          } catch (_) {
            /* ignore malformed client URLs */
          }
        }
        if (clientList.length > 0) {
          const client = clientList[0];
          if ("navigate" in client && typeof client.navigate === "function") {
            return client.focus().then((focused) =>
              focused && "navigate" in focused ? focused.navigate(targetUrl) : focused,
            );
          }
          return client.focus();
        }
        // Nothing open — launch a fresh window.
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      }),
  );
});
