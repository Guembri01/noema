"use client";

import { useEffect } from "react";
import { listenShell } from "@/lib/runtime-mode";
import {
  SHELL_MENU_EVENTS,
  shellEventName,
  shellWindowEvent,
} from "@/lib/shell-events";

/**
 * Translate the desktop shell's native menu into window events.
 *
 * Rendered once, near the document root, and inert everywhere else: on the site
 * there is no shell, `listenShell` returns `null`, and the effect does nothing.
 *
 * The shell emits `shell://<id>` when a menu item is clicked (`src-tauri/src/
 * shell.rs`); this turns each into `noema:shell:<id>` so any surface in the tree
 * can serve the ones it can and ignore the rest. That is why this component
 * knows nothing about workspaces, routing or quick find — the surfaces that do
 * subscribe to the window events.
 *
 * Kept separate from `DesktopThemeSync`, which pushes state *out* to the shell.
 * This one only listens *in*.
 */
export function DesktopShellBridge() {
  useEffect(() => {
    const unsubscribes = SHELL_MENU_EVENTS.map((id) =>
      listenShell(shellEventName(id), () => {
        window.dispatchEvent(new CustomEvent(shellWindowEvent(id)));
      }),
    ).filter((off): off is () => void => typeof off === "function");

    return () => {
      for (const off of unsubscribes) off();
    };
  }, []);

  return null;
}
