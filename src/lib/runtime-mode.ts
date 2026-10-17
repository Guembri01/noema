/**
 * Runtime mode — the single switch between the two shipped versions.
 *
 *  - **site**    : the hosted web app (Next.js server + Postgres). Default.
 *  - **desktop** : the installable app. A Tauri (Rust) shell hosts the same
 *                  Next.js build and runs it as a supervised local sidecar.
 *
 * Both versions share every component and every engine; only four things differ,
 * and they are resolved *here* so no feature code has to branch on `isDesktop`:
 *
 *   1. where the API lives        → `resolveApiBase()`
 *   2. where files live on disk   → `resolveDataDir()`
 *   3. whether OS chrome is ours  → `desktopChrome()` (title bar, tray, menus)
 *   4. whether native powers exist→ `nativeCapabilities()` (files, dialogs, shell)
 *
 * Nothing in this module throws: an unknown environment degrades to `site`, so a
 * misconfigured desktop build can never brick the UI.
 *
 * The mode itself comes from {@link runtimeMode}, which prefers the signal the
 * **server** rendered into the document. That matters: the shell evaluates its
 * bridge object into its own page and then navigates the window to the served
 * app, so anything injected that way is gone by the time the app runs — which is
 * why `isDesktop()` used to answer `false` inside the installed app.
 */

export type RuntimeMode = "site" | "desktop";

/**
 * The attribute the server writes the mode into: `<html data-noema-runtime>`.
 * Set in `src/app/layout.tsx` from `insideDesktopShell()` and read back by
 * {@link runtimeMode} — exported so the two ends cannot drift apart.
 */
export const RUNTIME_ATTRIBUTE = "data-noema-runtime";

/** The desktop shell's contract, mirrored from `src-tauri/src/main.rs`. */
export type DesktopBridge = {
  mode: "desktop";
  /** Base URL of the local Next.js sidecar, e.g. `http://127.0.0.1:47821`. */
  apiBase: string;
  /** Per-user writable directory (database, uploads, logs, backups). */
  dataDir: string;
  /** App version from `tauri.conf.json`. */
  appVersion: string;
  /** Platform triple, e.g. `windows-x86_64`. */
  platform: string;
};

declare global {
  interface Window {
    /**
     * Injected by the Tauri shell into its **own** page, which it then replaces
     * with the served app — so it is not there by the time the app runs (see
     * {@link runtimeMode}).
     */
    __NOEMA_DESKTOP__?: DesktopBridge;
    /**
     * Tauri's own global, injected on **every** page the webview hosts when
     * `withGlobalTauri` is on (see `src-tauri/tauri.conf.json`) — including the
     * served app, which is a different origin from the shell's own bootstrap
     * page. Only the narrow shape the app uses is declared.
     */
    __TAURI__?: {
      core?: {
        invoke?: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
  }
}

/**
 * The mode of the document that is running right now.
 *
 * Three signals, most authoritative first:
 *
 *  1. `data-noema-runtime` on `<html>`, rendered by the server that served this
 *     document (`insideDesktopShell()`). It survives the navigation from the
 *     shell's own page to the served app and exists during SSR, so it is the
 *     only signal the *served* app can rely on for free.
 *  2. `window.__NOEMA_DESKTOP__` — the shell's bridge object, evaluated into the
 *     document it is about to replace (so: the shell's own page only).
 *  3. `window.__TAURI__` — reinstalled by Tauri on every document the webview
 *     hosts, so it is present in the served app too. A fallback for a document
 *     that somehow lacks the attribute.
 */
export function runtimeMode(): RuntimeMode {
  if (typeof window === "undefined") return "site";
  if (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute(RUNTIME_ATTRIBUTE) === "desktop"
  ) {
    return "desktop";
  }
  if (window.__NOEMA_DESKTOP__?.mode === "desktop") return "desktop";
  if (window.__TAURI__?.core) return "desktop";
  return "site";
}

/** True when the page is running inside the Tauri shell. */
export function isDesktop(): boolean {
  return runtimeMode() === "desktop";
}

/**
 * Call a command in the desktop shell (see `src-tauri/src/commands.rs`), or
 * `null` when there is no shell to call — the site, a plain browser, or SSR.
 *
 * Deliberately independent of {@link desktopBridge}: the bridge object is
 * evaluated into the shell's *own* page and does not survive the navigation to
 * the served app, while Tauri's global is reinstalled on each document. A
 * rejected command resolves to `undefined` rather than throwing: shell commands
 * are enhancements, and nothing in the app may break because the shell said no.
 */
export function invokeShell(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> | null {
  if (typeof window === "undefined") return null;
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return null;
  return Promise.resolve()
    .then(() => invoke(command, args))
    .catch(() => undefined);
}

/**
 * The desktop bridge, or null in a browser.
 *
 * This is the **shell's own page** contract: the shell evaluates the object into
 * the document it is about to replace, so the served app never sees it. The
 * served app does not need it — it is served *by* the sidecar, which is why
 * `resolveApiBase()` correctly returns `""` (same-origin, relative fetches) for
 * any document reached through `runtimeMode()`'s server signal. Values that only
 * the shell knows (data dir, app version, platform triple) are available to the
 * served app from `desktop_info` instead.
 */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.__NOEMA_DESKTOP__;
  return bridge && bridge.mode === "desktop" ? bridge : null;
}

/**
 * The API origin.
 *
 * `site` is same-origin (""), so relative fetches keep working. `desktop` is the
 * loopback sidecar the shell started, which is a different origin from the
 * `tauri://` (or `http://tauri.localhost`) document — hence the explicit base.
 */
export function resolveApiBase(): string {
  return desktopBridge()?.apiBase ?? "";
}

/** Absolute URL for an API path, correct in both versions. */
export function apiUrl(path: string): string {
  const base = resolveApiBase();
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalised}`;
}

/**
 * Where the app keeps user data.
 *
 * Desktop always has one (`~/Library/Application Support/…`, `%APPDATA%\…`,
 * `~/.local/share/…`), the site keeps files in the storage driver instead.
 */
export function resolveDataDir(): string | null {
  return desktopBridge()?.dataDir ?? null;
}

/** App version: the desktop bridge value, else the build-time env, else "dev". */
export function appVersion(): string {
  return (
    desktopBridge()?.appVersion ??
    process.env.NEXT_PUBLIC_APP_VERSION ??
    "dev"
  );
}

/** Platform triple, `unknown` outside the shell. */
export function platform(): string {
  return desktopBridge()?.platform ?? "unknown";
}

/**
 * Whether the OS window chrome (title bar / menus) is drawn by the shell rather
 * than the page. Site: never. Desktop: the shell owns it, and the page reserves
 * the traffic-light inset instead of rendering its own bar.
 */
export function desktopChrome(): boolean {
  return isDesktop();
}

/** Which native integrations the shell exposes (all of them by default). */
export function nativeCapabilities(): {
  filesystem: boolean;
  dialogs: boolean;
  shell: boolean;
  notifications: boolean;
  updater: boolean;
  deepLinks: boolean;
  tray: boolean;
} {
  const on = isDesktop();
  return {
    filesystem: on,
    dialogs: on,
    shell: on,
    notifications: on,
    updater: on,
    deepLinks: on,
    tray: on,
  };
}

/**
 * Should the site's chrome be hidden? Used by the shell to avoid showing
 * "Sign in" affordances that do not apply inside the installed app (the app has
 * exactly one local user) and to skip marketing pages.
 */
export function hideSiteOnlyChrome(): boolean {
  return isDesktop();
}
