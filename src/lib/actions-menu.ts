/**
 * Pure model for the topbar Actions (⋯) menu (B11).
 *
 * Everything here is side-effect free so the ordering, filtering, grouping and
 * formatting rules can be unit-tested without a DOM: the React component in
 * `components/topbar/actions-menu.tsx` only renders what this module decides.
 * Strings are plain English on purpose — page-title/topbar is deliberately
 * un-translated until the B13 i18n tranche converts it.
 */

export type MenuItemKind = "action" | "toggle" | "submenu" | "disabled";

export type MenuGroup =
  | "clipboard"
  | "page"
  | "style"
  | "lock"
  | "ai"
  | "edit"
  | "transfer"
  | "insights"
  | "alerts"
  | "organize";

export type MenuItem = {
  id: string;
  label: string;
  group: MenuGroup;
  kind: MenuItemKind;
  /** Normalised accelerator, e.g. "ctrl+alt+l" (rendered by formatShortcut). */
  shortcut?: string;
  /** Extra search terms beyond the label. */
  keywords?: string[];
  /** Tooltip shown for disabled items. */
  hint?: string;
  /** Hidden entirely for read-only viewers. */
  editableOnly?: boolean;
};

/**
 * Canonical menu contents in Notion's order (parity batch B11, reference:
 * user-pasted Notion topbar + Actions dialog DOM).
 */
export const ACTIONS_MENU_ITEMS: MenuItem[] = [
  {
    id: "copy-link",
    label: "Copy link",
    group: "clipboard",
    kind: "action",
    shortcut: "ctrl+alt+l",
    keywords: ["url", "share link"],
  },
  {
    id: "copy-contents",
    label: "Copy page contents",
    group: "clipboard",
    kind: "action",
    keywords: ["clipboard", "markdown", "text", "copy"],
  },
  {
    id: "duplicate",
    label: "Duplicate",
    group: "page",
    kind: "action",
    shortcut: "ctrl+d",
    editableOnly: true,
    keywords: ["copy", "clone"],
  },
  {
    id: "move-to",
    label: "Move to",
    group: "page",
    kind: "submenu",
    shortcut: "ctrl+shift+p",
    editableOnly: true,
    keywords: ["move", "parent", "relocate"],
  },
  {
    id: "trash",
    label: "Move to Trash",
    group: "page",
    kind: "action",
    editableOnly: true,
    keywords: ["delete", "remove", "archive"],
  },
  {
    id: "small-text",
    label: "Small text",
    group: "style",
    kind: "toggle",
    editableOnly: true,
    keywords: ["font", "size", "compact"],
  },
  {
    id: "full-width",
    label: "Full width",
    group: "style",
    kind: "toggle",
    editableOnly: true,
    keywords: ["width", "layout"],
  },
  {
    id: "customize",
    label: "Customize page",
    group: "style",
    kind: "action",
    editableOnly: true,
    keywords: ["theme", "icon", "cover", "appearance", "dark", "light"],
  },
  {
    id: "lock",
    label: "Lock page",
    group: "lock",
    kind: "toggle",
    editableOnly: true,
    keywords: ["protect", "edit"],
  },
  {
    id: "use-ai",
    label: "Use with AI",
    group: "ai",
    kind: "submenu",
    keywords: ["ai", "ask", "summarize", "chat"],
  },
  {
    id: "suggest",
    label: "Suggest edits",
    group: "ai",
    kind: "action",
    keywords: ["ai", "improve", "feedback", "review"],
  },
  {
    id: "translate",
    label: "Translate",
    group: "ai",
    kind: "submenu",
    keywords: [
      "language",
      "locale",
      "english",
      "français",
      "french",
      "español",
      "spanish",
      "deutsch",
      "german",
      "العربية",
      "arabic",
    ],
  },
  {
    id: "undo",
    label: "Undo",
    group: "edit",
    kind: "action",
    shortcut: "ctrl+z",
    editableOnly: true,
    keywords: ["revert", "history"],
  },
  {
    id: "import",
    label: "Import",
    group: "transfer",
    kind: "action",
    keywords: ["notion", "upload", "bring"],
  },
  {
    id: "export",
    label: "Export",
    group: "transfer",
    kind: "submenu",
    keywords: ["download", "pdf", "json", "html"],
  },
  {
    id: "wiki",
    label: "Turn into wiki",
    group: "transfer",
    kind: "disabled",
    hint: "Wiki coming soon",
    keywords: ["wiki", "knowledge base"],
  },
  {
    id: "updates",
    label: "Updates & analytics",
    group: "insights",
    kind: "action",
    keywords: ["analytics", "word count", "stats", "timeline"],
  },
  {
    id: "history",
    label: "Version history",
    group: "insights",
    kind: "action",
    keywords: ["versions", "revisions"],
  },
  {
    id: "notify",
    label: "Notify me",
    group: "alerts",
    kind: "submenu",
    keywords: ["notifications", "comments", "mentions"],
  },
  {
    id: "connections",
    label: "Connections",
    group: "alerts",
    kind: "submenu",
    keywords: ["integrations", "webhooks", "oauth", "apps"],
  },
  {
    id: "workspace-move",
    label: "Move to workspace",
    group: "organize",
    kind: "submenu",
    editableOnly: true,
  },
  {
    id: "teamspace-move",
    label: "Move to teamspace",
    group: "organize",
    kind: "submenu",
    editableOnly: true,
  },
  {
    id: "share-access",
    label: "Who has access",
    group: "organize",
    kind: "action",
    editableOnly: true,
    keywords: ["permissions", "access", "people"],
  },
];

/** The subset of the menu a given viewer is allowed to see. */
export function visibleMenuItems(ctx: {
  editable: boolean;
  locked?: boolean;
}): MenuItem[] {
  return ACTIONS_MENU_ITEMS.filter((item) => {
    // The Lock toggle must stay reachable on a locked page, or it could never
    // be unlocked; pure read-only viewers never see it.
    if (item.id === "lock") return ctx.editable || Boolean(ctx.locked);
    return !item.editableOnly || ctx.editable;
  });
}

/**
 * Live filter for the "Search actions…" input. Every whitespace-separated
 * token must appear (case-insensitively) in the label, keywords or hint;
 * surviving items keep their canonical Notion order.
 */
export function filterMenuItems(
  query: string,
  items: MenuItem[] = ACTIONS_MENU_ITEMS,
): MenuItem[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = [item.label, ...(item.keywords ?? []), item.hint ?? ""]
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** Bucket filtered items by group, first-appearance order, empties dropped. */
export function groupMenuItems(
  items: MenuItem[],
): { group: MenuGroup; items: MenuItem[] }[] {
  const groups: { group: MenuGroup; items: MenuItem[] }[] = [];
  for (const item of items) {
    const bucket = groups.find((entry) => entry.group === item.group);
    if (bucket) bucket.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}

/** "ctrl+alt+l" → "Ctrl+Alt+L" (shortcuts render right-aligned in the menu). */
export function formatShortcut(shortcut: string | undefined): string {
  if (!shortcut) return "";
  const NAMES: Record<string, string> = {
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
    cmd: "Cmd",
  };
  return shortcut
    .split("+")
    .map((part) => NAMES[part.toLowerCase()] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("+");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Relative last-edited label for the topbar: "Edited 5m ago" etc. */
export function formatEditedLabel(value: string | Date, now: Date): string {
  const date = toDate(value);
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return "Edited just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `Edited ${minutes}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `Edited ${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `Edited ${days}d ago`;
  return `Edited ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** Word count + characters + a 200-wpm reading estimate. */
export function formatWordStats(text: string): {
  words: number;
  chars: number;
  reading: string;
} {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const reading =
    words === 0 ? "0 min read" : `${Math.max(1, Math.ceil(words / 200))} min read`;
  return { words, chars: trimmed.length, reading };
}

function clockLabel(date: Date): string {
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  const suffix = date.getHours() < 12 ? "AM" : "PM";
  return `${hour}:${minute} ${suffix}`;
}

/** Menu footer timestamp: "Today at 3:42 PM" / "Oct 14 at 3:42 PM". */
export function formatFooterTime(value: string | Date, now: Date): string {
  const date = toDate(value);
  const clock = clockLabel(date);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `Today at ${clock}`;
  const year =
    date.getFullYear() === now.getFullYear() ? "" : `, ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year} at ${clock}`;
}
