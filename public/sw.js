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

  const title = (data && data.title) || "ICC Desk";
  const options = {
    body: data && data.body ? String(data.body) : undefined,
    tag: data && data.tag ? String(data.tag) : undefined,
    icon: "/icons/icon-192.webp",
    badge: "/icons/icon-96.webp",
    data: { url: (data && data.url) || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
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
