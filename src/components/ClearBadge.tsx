"use client";

import { useEffect } from "react";
import { setTabBadge } from "@/lib/tab-badge";

/**
 * Clears the unread badge on the way out of a session.
 *
 * Reaching the login screen means there is no session any more — someone
 * signed out, the inactivity redirect fired, or a token expired. The tab's
 * own title and favicon die with the page, but an INSTALLED app's icon
 * badge does not: it survives the app being closed, which is the whole
 * point of it. Without this, the next person to pick up a shared phone
 * sees a count belonging to an account that is not theirs.
 *
 * Rendered on the login page, so it covers every route out of a session
 * rather than just the sign-out button.
 */
export function ClearBadge() {
  useEffect(() => {
    setTabBadge(0);
  }, []);
  return null;
}
