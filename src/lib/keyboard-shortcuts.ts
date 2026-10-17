/**
 * Keyboard shortcut registry: the pure model behind the FEATURE_MATRIX rows
 * "Keyboard shortcuts" (:586) and the planned shortcuts
 * — quick find (:587), new page (:588), search (:589), toggle sidebar (:590),
 * duplicate block (:593), undo/redo (:594) — plus the already-mapped editor
 * formatting (:591) and block-move (:592) chords.
 *
 * A shortcut is written once as a platform-agnostic string such as
 * `"Mod+Shift+K"`, where **Mod** means ⌘ on macOS and Ctrl everywhere else.
 * This module turns that string into a structure (`parseCombo`), a canonical
 * form (`normalizeCombo`), a platform display label (`formatCombo`), a
 * predicate over a DOM-like event (`matchesCombo`), a conflict report across a
 * set of bindings (`findConflicts`) and a lookup (`resolveShortcut`).
 *
 * Everything is side-effect free — no DOM, no React, no I/O — so the whole
 * registry can be unit-tested in the node environment and shared by the
 * browser key handler and the settings UI without pulling either in.
 */

/** Where a shortcut is active. Editor chords only fire with focus in the editor. */
export type ShortcutScope = "global" | "editor";

/** One entry in a shortcut catalog: a stable id, a label and its combo. */
export type ShortcutBinding = {
  /** Stable identifier the handler dispatches on, e.g. `"search"`. */
  id: string;
  /** Human-readable name, e.g. `"Search"`. */
  label: string;
  /** Platform-agnostic combo, e.g. `"Mod+K"`. */
  combo: string;
  /** Defaults to `"global"` when omitted. */
  scope?: ShortcutScope;
  /** Extra search terms for a settings/keyboard-help list. */
  keywords?: string[];
};

/**
 * The slice of a keyboard event this module needs. Only `key` is required, so
 * tests can pass a literal and the browser can pass a `KeyboardEvent`.
 */
export type KeyEventLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/** Platform hint. `isMac` selects the meaning of Mod and the display symbols. */
export type PlatformOptions = { isMac?: boolean };

/** A combo broken into its canonical key plus its modifier flags. */
export type ParsedCombo = {
  /** Canonical key: `"K"`, `"ArrowUp"`, `" "` (Space), `"\\"`, `"Escape"`. */
  key: string;
  /** The abstract Mod (⌘ on mac, Ctrl elsewhere). */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/** A group of bindings that would fire on the same keystroke on one platform. */
export type ShortcutConflict = {
  /** The resolved combo they share, e.g. `"Ctrl+K"`. */
  combo: string;
  /** The colliding binding ids, in input order. */
  ids: string[];
};

type ModifierFlag = "mod" | "ctrl" | "meta" | "alt" | "shift";

/** Modifier spellings → the flag they set. Keys are matched lower-cased. */
const MODIFIER_ALIASES: Record<string, ModifierFlag> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/**
 * Named-key spellings → the canonical `KeyboardEvent.key` value. Keys are
 * matched lower-cased; single characters fall through to {@link canonicalKey}.
 */
const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: " ",
  spacebar: " ",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

/** Canonicalise one non-modifier token: alias lookup, then case folding. */
function canonicalKey(token: string): string {
  const alias = KEY_ALIASES[token.toLowerCase()];
  if (alias !== undefined) return alias;
  if (token.length === 1) return token.toUpperCase();
  if (/^f([1-9]|1[0-2])$/i.test(token)) return token.toUpperCase();
  return token;
}

/** The token to print/serialise for a canonical key (Space has no character). */
function keyToken(key: string): string {
  return key === " " ? "Space" : key;
}

/**
 * Parse a combo into its key and modifiers. Modifier order is irrelevant and
 * casing is ignored (`"shift+mod+k"`, `"Mod+Shift+K"` both parse). Returns
 * `null` for an empty string, an empty token (`"Mod++K"`, `"nope+"`) or more
 * than one non-modifier key (`"A+B"`).
 */
export function parseCombo(combo: string): ParsedCombo | null {
  if (typeof combo !== "string") return null;
  const tokens = combo.split("+").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) return null;

  const parsed: ParsedCombo = {
    key: "",
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  };
  let key: string | null = null;

  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    if (key !== null) return null; // a second non-modifier key is ambiguous
    key = canonicalKey(token);
  }

  if (key === null) return null;
  parsed.key = key;
  return parsed;
}

/**
 * Rewrite a combo in canonical form: modifiers in the order
 * Mod · Ctrl · Meta · Alt · Shift, the key named as its canonical token.
 * `"shift+mod+k"` → `"Mod+Shift+K"`, `"command+k"` → `"Meta+K"`. Returns `null`
 * when the combo cannot be parsed. Output is idempotent.
 */
export function normalizeCombo(combo: string): string | null {
  const parsed = parseCombo(combo);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Meta");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(keyToken(parsed.key));
  return parts.join("+");
}

/** Can the combo fire on macOS's ⌘? True when it carries Mod or Meta. */
function resolveModifiers(parsed: ParsedCombo, isMac: boolean) {
  return {
    ctrl: parsed.ctrl || (parsed.mod && !isMac),
    meta: parsed.meta || (parsed.mod && isMac),
    alt: parsed.alt,
    shift: parsed.shift,
  };
}

/** macOS glyphs for named keys; letters and symbols print as themselves. */
const MAC_KEY_SYMBOLS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
  " ": "Space",
};

/**
 * Render a combo for display. On macOS, modifiers become symbols joined to the
 * key with no separator (`"⌘⇧K"`, `"⌘⌥↑"`); elsewhere they are spelled out with
 * `+` (`"Ctrl+Shift+K"`), de-duplicating the Mod/Ctrl overlap. Returns `""` for
 * an invalid combo or one that would render empty.
 */
export function formatCombo(combo: string, options: PlatformOptions = {}): string {
  const parsed = parseCombo(combo);
  if (!parsed) return "";

  if (options.isMac) {
    const mods: string[] = [];
    if (parsed.mod || parsed.meta) mods.push("⌘");
    if (parsed.ctrl) mods.push("⌃");
    if (parsed.alt) mods.push("⌥");
    if (parsed.shift) mods.push("⇧");
    const key = MAC_KEY_SYMBOLS[parsed.key] ?? parsed.key;
    return mods.join("") + key;
  }

  const parts: string[] = [];
  if (parsed.mod) parts.push("Ctrl");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Meta");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(keyToken(parsed.key));
  return parts.filter((part, index) => parts.indexOf(part) === index).join("+");
}

/**
 * The display combo for a binding id, or `""` when no such binding exists.
 *
 * The one way to put a chord on screen: a surface names the binding it mirrors
 * and the registry decides the text. Hardcoding `"Ctrl K"` next to a button is
 * how a hint drifts from the key that actually fires — and how it ends up wrong
 * on macOS.
 */
export function formatShortcut(id: string, options: PlatformOptions = {}): string {
  const binding = DEFAULT_SHORTCUTS.find((entry) => entry.id === id);
  return binding ? formatCombo(binding.combo, options) : "";
}

/**
 * Does an event exactly satisfy a combo? All of the combo's modifiers must be
 * held and no others — so `"Mod+K"` rejects ⌘⇧K. Mod resolves to Meta on macOS
 * and Ctrl elsewhere via `options.isMac`. Letters compare case-insensitively
 * and Space accepts the `" "` event key.
 */
export function matchesCombo(
  combo: string,
  event: KeyEventLike | null | undefined,
  options: PlatformOptions = {},
): boolean {
  if (!event || typeof event.key !== "string") return false;
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  if (canonicalKey(event.key) !== parsed.key) return false;

  const want = resolveModifiers(parsed, Boolean(options.isMac));
  return (
    want.ctrl === Boolean(event.ctrlKey) &&
    want.meta === Boolean(event.metaKey) &&
    want.alt === Boolean(event.altKey) &&
    want.shift === Boolean(event.shiftKey)
  );
}

/**
 * Find bindings that would fire on the same keystroke. Combos are resolved for
 * the given platform (default non-mac), so `"Mod+K"` and `"Ctrl+K"` collide on
 * Windows while `"Mod+K"` and `"Meta+K"` collide on macOS. Each returned group
 * carries the resolved combo and its colliding ids, in input order; a
 * conflict-free set yields `[]`.
 */
export function findConflicts(
  bindings: readonly ShortcutBinding[],
  options: PlatformOptions = {},
): ShortcutConflict[] {
  const isMac = Boolean(options.isMac);
  const buckets = new Map<string, string[]>();

  for (const binding of bindings) {
    const parsed = parseCombo(binding.combo);
    if (!parsed) continue;
    const want = resolveModifiers(parsed, isMac);
    const signature = [
      want.ctrl ? "Ctrl" : "",
      want.meta ? "Meta" : "",
      want.alt ? "Alt" : "",
      want.shift ? "Shift" : "",
      keyToken(parsed.key),
    ]
      .filter((part) => part.length > 0)
      .join("+");
    const ids = buckets.get(signature);
    if (ids) ids.push(binding.id);
    else buckets.set(signature, [binding.id]);
  }

  const conflicts: ShortcutConflict[] = [];
  for (const [combo, ids] of buckets) {
    if (ids.length > 1) conflicts.push({ combo, ids });
  }
  return conflicts;
}

/**
 * Resolve an event to the first binding that matches it, respecting platform
 * Mod resolution and the binding's own combo. Returns `null` when nothing in
 * the list fires.
 */
export function resolveShortcut(
  bindings: readonly ShortcutBinding[],
  event: KeyEventLike | null | undefined,
  options: PlatformOptions = {},
): ShortcutBinding | null {
  for (const binding of bindings) {
    if (matchesCombo(binding.combo, event, options)) return binding;
  }
  return null;
}

/**
 * The default catalog: the global chords the FEATURE_MATRIX lists as planned
 * plus the editor chords already mapped. All combos are conflict-free.
 */
export const DEFAULT_SHORTCUTS: readonly ShortcutBinding[] = [
  {
    id: "search",
    label: "Search",
    combo: "Mod+K",
    scope: "global",
    keywords: ["quick switch", "jump to"],
  },
  { id: "quick-find", label: "Quick find", combo: "Mod+P", scope: "global", keywords: ["search"] },
  { id: "new-page", label: "New page", combo: "Mod+N", scope: "global" },
  {
    id: "toggle-sidebar",
    label: "Toggle sidebar",
    combo: "Mod+Shift+\\",
    scope: "global",
    keywords: ["navigation", "panel"],
  },
  { id: "bold", label: "Bold", combo: "Mod+B", scope: "editor" },
  { id: "italic", label: "Italic", combo: "Mod+I", scope: "editor" },
  { id: "underline", label: "Underline", combo: "Mod+U", scope: "editor" },
  {
    id: "duplicate-block",
    label: "Duplicate block",
    combo: "Mod+D",
    scope: "editor",
    keywords: ["clone", "copy"],
  },
  { id: "move-block-up", label: "Move block up", combo: "Alt+ArrowUp", scope: "editor" },
  { id: "move-block-down", label: "Move block down", combo: "Alt+ArrowDown", scope: "editor" },
  { id: "undo", label: "Undo", combo: "Mod+Z", scope: "editor" },
  { id: "redo", label: "Redo", combo: "Mod+Shift+Z", scope: "editor" },
];
