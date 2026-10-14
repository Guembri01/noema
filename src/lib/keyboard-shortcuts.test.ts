import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  findConflicts,
  formatCombo,
  matchesCombo,
  normalizeCombo,
  parseCombo,
  resolveShortcut,
  type ShortcutBinding,
} from "./keyboard-shortcuts";

/**
 * Red-first suite for the pure keyboard-shortcut registry behind the
 * FEATURE_MATRIX rows "Keyboard shortcuts" (:586) and the planned
 * "Shortcut: quick find / new page / search / toggle sidebar / duplicate block"
 * rows (:587-:593). It owns the parsing, cross-platform Mod handling, display
 * formatting, conflict detection and event resolution — no DOM, no React, no
 * I/O, so every rule is unit-testable in the node environment.
 */

const isMac = { isMac: true };
const isWin = { isMac: false };

describe("parseCombo — structure, aliases and failure modes", () => {
  it("splits modifiers from the key and canonicalises the key", () => {
    expect(parseCombo("Mod+Shift+K")).toEqual({
      key: "K",
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: true,
    });
    expect(parseCombo("ctrl+alt+delete")).toMatchObject({
      key: "Delete",
      ctrl: true,
      alt: true,
      mod: false,
    });
  });

  it("folds platform aliases (cmd/command→meta, option→alt, esc→Escape)", () => {
    expect(parseCombo("Cmd+K")).toMatchObject({ meta: true, key: "K" });
    expect(parseCombo("option+up")).toMatchObject({ alt: true, key: "ArrowUp" });
    expect(parseCombo("ESC")).toMatchObject({ key: "Escape" });
  });

  it("returns null for empty input or a combo with two non-modifier keys", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("   ")).toBeNull();
    expect(parseCombo("Mod++K")).toBeNull();
    expect(parseCombo("A+B")).toBeNull();
  });
});

describe("normalizeCombo — canonical ordering and idempotence", () => {
  it("reorders modifiers and rewrites aliases to their canonical token", () => {
    expect(normalizeCombo("shift+mod+k")).toBe("Mod+Shift+K");
    expect(normalizeCombo("control+alt+delete")).toBe("Ctrl+Alt+Delete");
    expect(normalizeCombo("command+k")).toBe("Meta+K");
  });

  it("is idempotent and round-trips a space key as the literal name", () => {
    const once = normalizeCombo("mod+space");
    expect(once).toBe("Mod+Space");
    expect(normalizeCombo(once as string)).toBe("Mod+Space");
  });

  it("returns null for an unparsable combo", () => {
    expect(normalizeCombo("nope+")).toBeNull();
  });
});

describe("formatCombo — platform display", () => {
  it("symbolises modifiers and keys on macOS", () => {
    expect(formatCombo("Mod+Shift+K", isMac)).toBe("⌘⇧K");
    expect(formatCombo("Mod+Alt+ArrowUp", isMac)).toBe("⌘⌥↑");
    expect(formatCombo("Meta+Enter", isMac)).toBe("⌘↩");
  });

  it("spells modifiers out on non-mac platforms and de-duplicates Ctrl", () => {
    expect(formatCombo("Mod+Shift+K", isWin)).toBe("Ctrl+Shift+K");
    expect(formatCombo("Mod+Ctrl+K", isWin)).toBe("Ctrl+K");
    expect(formatCombo("Alt+ArrowDown", isWin)).toBe("Alt+ArrowDown");
  });

  it("returns an empty string for an invalid combo", () => {
    expect(formatCombo("", isMac)).toBe("");
    expect(formatCombo("A+B", isWin)).toBe("");
  });
});

describe("matchesCombo — event resolution and Mod abstraction", () => {
  const event = {
    key: "k",
    ctrlKey: false,
    metaKey: true,
    altKey: false,
    shiftKey: true,
  };

  it("resolves Mod to Meta on macOS and Ctrl elsewhere", () => {
    expect(matchesCombo("Mod+Shift+K", event, isMac)).toBe(true);
    expect(matchesCombo("Mod+Shift+K", event, isWin)).toBe(false);
    expect(matchesCombo("Mod+Shift+K", { ...event, metaKey: false, ctrlKey: true }, isWin)).toBe(
      true,
    );
  });

  it("requires an exact modifier match — extra modifiers break it", () => {
    expect(matchesCombo("Mod+K", event, isMac)).toBe(false); // shift also held
    expect(matchesCombo("Mod+Alt+K", event, isMac)).toBe(false);
    expect(matchesCombo("Mod+Shift+K", { ...event, key: "J" }, isMac)).toBe(false);
  });

  it("compares letter case insensitively and understands the space key", () => {
    expect(matchesCombo("Mod+K", { key: "K", metaKey: true }, isMac)).toBe(true);
    expect(matchesCombo("Mod+Space", { key: " ", metaKey: true }, isMac)).toBe(true);
  });

  it("is false for a missing event or an unparsable combo", () => {
    expect(matchesCombo("Mod+K", undefined, isMac)).toBe(false);
    expect(matchesCombo("A+B", event, isMac)).toBe(false);
  });
});

describe("findConflicts — duplicate bindings per platform", () => {
  it("groups bindings that fire on the same keystroke", () => {
    const bindings: ShortcutBinding[] = [
      { id: "a", label: "A", combo: "Mod+K" },
      { id: "b", label: "B", combo: "ctrl+k" },
      { id: "c", label: "C", combo: "Mod+J" },
    ];
    expect(findConflicts(bindings, isWin)).toEqual([{ combo: "Ctrl+K", ids: ["a", "b"] }]);
    // On macOS, ctrl+k and mod+k are genuinely different chords.
    expect(findConflicts(bindings, isMac)).toEqual([]);
  });

  it("reports nothing for a conflict-free catalog", () => {
    expect(findConflicts(DEFAULT_SHORTCUTS, isWin)).toEqual([]);
    expect(findConflicts(DEFAULT_SHORTCUTS, isMac)).toEqual([]);
  });
});

describe("resolveShortcut — event → binding", () => {
  it("returns the matching binding for a real event", () => {
    const hit = resolveShortcut(DEFAULT_SHORTCUTS, { key: "k", ctrlKey: true }, isWin);
    expect(hit?.id).toBe("search");
    expect(hit?.scope).toBe("global");
  });

  it("returns null when nothing matches", () => {
    expect(resolveShortcut(DEFAULT_SHORTCUTS, { key: "k" }, isWin)).toBeNull();
    expect(resolveShortcut(DEFAULT_SHORTCUTS, { key: "q", ctrlKey: true }, isWin)).toBeNull();
  });
});

describe("DEFAULT_SHORTCUTS — catalog wiring", () => {
  const comboFor = (id: string) => DEFAULT_SHORTCUTS.find((s) => s.id === id)?.combo;

  it("matches the planned matrix rows", () => {
    expect(comboFor("quick-find")).toBe("Mod+P");
    expect(comboFor("new-page")).toBe("Mod+N");
    expect(comboFor("search")).toBe("Mod+K");
    expect(comboFor("toggle-sidebar")).toBe("Mod+Shift+\\");
    expect(comboFor("duplicate-block")).toBe("Mod+D");
    expect(comboFor("undo")).toBe("Mod+Z");
    expect(comboFor("redo")).toBe("Mod+Shift+Z");
  });

  it("uses unique ids and canonical combos", () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shortcut of DEFAULT_SHORTCUTS) {
      expect(normalizeCombo(shortcut.combo)).toBe(shortcut.combo);
    }
  });
});
