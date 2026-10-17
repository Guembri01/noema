import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHELL_MENU_EVENTS,
  SHELL_WINDOW_EVENT_PREFIX,
  shellEventName,
  shellMenuEventFrom,
  shellWindowEvent,
} from "./shell-events";

describe("shell menu events", () => {
  it("round-trips every id through both names", () => {
    for (const id of SHELL_MENU_EVENTS) {
      expect(shellEventName(id)).toBe(`shell://${id}`);
      expect(shellWindowEvent(id)).toBe(`${SHELL_WINDOW_EVENT_PREFIX}${id}`);
      expect(shellMenuEventFrom(shellEventName(id))).toBe(id);
    }
  });

  it("ignores anything that is not a menu id", () => {
    for (const junk of [
      "sidecar://event",
      "shell://",
      "shell://nonexistent",
      "shell:new-note",
      "noema:shell:new-note",
      "",
    ]) {
      expect(shellMenuEventFrom(junk)).toBeNull();
    }
  });

  it("keeps the window event names in their own namespace", () => {
    // `noema:open-chat` already lives in this space; a menu id must never
    // collide with a surface's own event.
    for (const id of SHELL_MENU_EVENTS) {
      expect(shellWindowEvent(id).startsWith(SHELL_WINDOW_EVENT_PREFIX)).toBe(true);
      expect(shellWindowEvent(id)).not.toBe("noema:open-chat");
    }
  });
});

describe("the shell and the app agree on the menu", () => {
  /**
   * The Rust menu is the source of truth for what a click emits. This reads it
   * and fails if it emits an event this module does not know — which is exactly
   * how the whole menu came to be dead: the shell emitted, nothing listened, and
   * no test compared the two lists.
   */
  it("emits exactly the events declared here", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src-tauri/src/shell.rs"),
      "utf8",
    );
    const emitted = [...source.matchAll(/"(shell:\/\/[a-z-]+)"/g)].map(
      (match) => match[1],
    );
    expect(emitted.length).toBeGreaterThan(0);

    const declared = new Set<string>(SHELL_MENU_EVENTS.map(shellEventName));
    const undeclared = emitted.filter((event) => !declared.has(event));
    expect(undeclared).toEqual([]);

    // And the other direction: an id declared here that the shell never emits
    // would be a listener that can never fire.
    const emittedSet = new Set(emitted);
    const unemitted = [...declared].filter((event) => !emittedSet.has(event));
    expect(unemitted).toEqual([]);
  });
});
