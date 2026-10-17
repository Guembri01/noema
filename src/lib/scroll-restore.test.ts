import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SCROLL_RESTORE_PREFIX,
  applyScrollPosition,
  clampScrollPosition,
  readScrollPosition,
  scrollRestoreKey,
  useScrollRestore,
  writeScrollPosition,
  type ScrollStorage,
} from "./scroll-restore";

/**
 * Scroll restore — the DOM-free store helpers are pinned for corrupt / absent /
 * blocking storage, and a static render proves the hook mounts and hands back a
 * usable ref + save without a live DOM.
 */

/** An in-memory `Storage` stand-in that records what was written. */
function fakeStorage(initial: Record<string, string> = {}): ScrollStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("scrollRestoreKey", () => {
  it("namespaces the surface under the shared prefix", () => {
    expect(SCROLL_RESTORE_PREFIX).toBe("noema:scroll");
    expect(scrollRestoreKey("trash:ws1")).toBe("noema:scroll:trash:ws1");
  });
});

describe("clampScrollPosition", () => {
  it("rounds to whole px and never goes negative", () => {
    expect(clampScrollPosition(120.4)).toBe(120);
    expect(clampScrollPosition(-40)).toBe(0);
    expect(clampScrollPosition(Number.NaN)).toBe(0);
    expect(clampScrollPosition(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("readScrollPosition / writeScrollPosition", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    writeScrollPosition(storage, "k", 240.6);
    expect(storage.map.get("k")).toBe("241");
    expect(readScrollPosition(storage, "k")).toBe(241);
  });

  it("reads 0 for an absent, empty or corrupt value", () => {
    const storage = fakeStorage({ empty: "  ", corrupt: "not-a-number" });
    expect(readScrollPosition(storage, "missing")).toBe(0);
    expect(readScrollPosition(storage, "empty")).toBe(0);
    expect(readScrollPosition(storage, "corrupt")).toBe(0);
  });

  it("is a no-op with no storage, and survives a throwing store", () => {
    expect(readScrollPosition(null, "k")).toBe(0);
    expect(() => writeScrollPosition(null, "k", 10)).not.toThrow();
    const throwing: ScrollStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readScrollPosition(throwing, "k")).toBe(0);
    expect(() => writeScrollPosition(throwing, "k", 10)).not.toThrow();
  });
});

describe("applyScrollPosition", () => {
  it("sets a clamped offset and returns what it applied", () => {
    const node = { scrollTop: 0 };
    expect(applyScrollPosition(node, 180.7)).toBe(181);
    expect(node.scrollTop).toBe(181);
  });

  it("does nothing without a node", () => {
    expect(applyScrollPosition(null, 180)).toBe(0);
  });

  it("never applies a negative offset", () => {
    const node = { scrollTop: 50 };
    expect(applyScrollPosition(node, -20)).toBe(0);
    expect(node.scrollTop).toBe(0);
  });
});

describe("useScrollRestore", () => {
  function Probe() {
    const restore = useScrollRestore("probe", { storage: null });
    return createElement("div", { ref: restore.ref }, `save:${typeof restore.save}`);
  }

  it("mounts and exposes a ref plus a save function", () => {
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain("save:function");
  });
});
