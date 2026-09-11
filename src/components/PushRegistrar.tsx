"use client";

import { useEffect } from "react";
import { notificationPermission } from "@/lib/notify";
import { savePushSubscription } from "@/lib/push/client";

/**
 * Invisible helper mounted app-wide. If this device has already granted
 * notification permission, it (re)registers the browser's push subscription
 * with the server on load, so closed-app pushes keep working even if the
 * subscription rotated or the server row was lost. Does nothing until the
 * user opts in via the notification settings.
 */
export function PushRegistrar() {
  useEffect(() => {
    if (notificationPermission() !== "granted") return;
    void savePushSubscription();
  }, []);
  return null;
}
