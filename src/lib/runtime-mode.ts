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
 */

export type RuntimeMode = "site" | "desktop";

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
    /** Injected by the Tauri shell before the webview loads the app. */
    __NOEMA_DESKTOP__?: DesktopBridge;
  }
}

/** True when the page is running inside the Tauri shell. */
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.__NOEMA_DESKTOP__?.mode === "desktop");
}

/** The desktop bridge, or null in a browser. */
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
