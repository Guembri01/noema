import { describe, expect, it } from "vitest";
import { shortcutFor, type ShortcutEvent } from "./undo-redo-provider";

/**
 * Wiring proof for `src/lib/undo-redo.ts` → the global provider.
 *
 * The engine's 59 tests cover push/undo/redo/merge/coalesce. The only new pure
 * decision the provider adds is the keydown → action mapping, so that is what
 * this suite locks down (both modifier families and the ignore cases).
 */

const key = (
  k: string,
  mods: Partial<Omit<ShortcutEvent, "key">> = {},
): ShortcutEvent => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcutFor", () => {
  it("maps Ctrl/Cmd+Z to undo", () => {
    expect(shortcutFor(key("z", { ctrlKey: true }))).toBe("undo");
    expect(shortcutFor(key("Z", { metaKey: true }))).toBe("undo");
  });

  it("maps Ctrl/Cmd+Shift+Z and Ctrl+Y to redo", () => {
    expect(shortcutFor(key("z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(shortcutFor(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(shortcutFor(key("y", { ctrlKey: true }))).toBe("redo");
  });

  it("ignores chords it does not own", () => {
    expect(shortcutFor(key("z"))).toBeNull();
    expect(shortcutFor(key("a", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});
