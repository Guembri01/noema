import { describe, expect, it } from "vitest";
import { cleanDisplayText, uniqueRows } from "./display-text";

describe("cleanDisplayText", () => {
  it("strips Markdown heading markers that leaked into stored labels", () => {
    expect(cleanDisplayText("### rr")).toBe("rr");
    expect(cleanDisplayText("## Bugs\nbody")).toBe("Bugs\nbody");
  });

  it("keeps inline hashes that are not heading markers", () => {
    expect(cleanDisplayText("issue #12")).toBe("issue #12");
    expect(cleanDisplayText("C# guide")).toBe("C# guide");
  });

  it("collapses blank runs and adjacent duplicate lines", () => {
    expect(cleanDisplayText("One\nOne\n\n\nTwo\n")).toBe("One\n\nTwo");
  });

  it("normalises Windows line endings", () => {
    expect(cleanDisplayText("A\r\nB")).toBe("A\nB");
  });
});

describe("uniqueRows", () => {
  it("keeps first-seen order and drops duplicate keys", () => {
    const rows = [
      { id: "a", label: "first" },
      { id: "b", label: "second" },
      { id: "a", label: "duplicate" },
    ];
    expect(uniqueRows(rows, (row) => row.id)).toEqual([
      { id: "a", label: "first" },
      { id: "b", label: "second" },
    ]);
  });
});
