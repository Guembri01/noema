"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { invokeShell } from "@/lib/runtime-mode";

/**
 * Keep the OS window chrome in step with the workspace theme.
 *
 * `next-themes` puts `class="dark"` on `<html>`, which styles the page — but the
 * title bar, menus and scrollbars are drawn by the OS, so they follow the
 * desktop's own light/dark setting instead. On a dark-skinned Windows a light
 * workspace therefore showed a dark title bar above a light page.
 *
 * The shell owns the chrome, so the resolved *preference* is handed to it (not
 * the resolved colour): `"system"` tells the shell to leave the window to the
 * OS, which keeps following it live as the user changes the desktop setting.
 * The shell also persists the value, so the next launch has the right chrome
 * before the page has loaded anything.
 *
 * Outside the desktop `invokeShell` returns `null`, so this is inert on the
 * site — and a shell that cannot answer never breaks the page.
 */
export function DesktopThemeSync() {
  const { theme } = useTheme();

  useEffect(() => {
    if (!theme) return;
    void invokeShell("set_theme", { theme });
  }, [theme]);

  return null;
}
