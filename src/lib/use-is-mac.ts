"use client";

import { useEffect, useState } from "react";

/**
 * Whether this is an Apple platform — the one fact that decides how a chord is
 * spelled (`⌘K` versus `Ctrl+K`).
 *
 * The user agent is the only signal available before a key is pressed, and it
 * is only readable in the browser. The hook therefore starts `false` and settles
 * after mount: `⌘` on the server would be a guess, and a wrong guess is a
 * hydration mismatch. `false` is also the right first paint for the majority of
 * installs, so the correction is usually a no-op.
 *
 * Exported separately from the hook so the rule itself is testable in the node
 * environment, where there is no `navigator`.
 */

/** iPadOS 13+ reports itself as `Macintosh`, so the tablet case rides along. */
export const APPLE_USER_AGENT = /mac|iphone|ipad|ipod/i;

/** Pure form of {@link useIsMac}, for tests and non-React callers. */
export function isApplePlatform(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && APPLE_USER_AGENT.test(userAgent);
}

/** True on Apple platforms, false everywhere else — and false during SSR. */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(isApplePlatform(navigator.userAgent));
  }, []);
  return isMac;
}
