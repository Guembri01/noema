import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Inbox label coverage. `page.updated` is written by the page-follow dispatch
 * (`notifyPageUpdated`) and rendered by the inbox, but the `LABELS` map had no
 * entry for it, so those rows fell back to the raw event id
 * (`LABELS[type] ?? type`). This guards the fix.
 *
 * The map is a module-private constant in the page component, so the test reads
 * the file source rather than importing the server component (which would pull
 * the whole server-render graph into a unit test).
 */
const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("inbox LABELS coverage", () => {
  it("has a human label for page.updated (never a raw event id)", () => {
    expect(source).toMatch(/"page\.updated":\s*"[^"]+"/);
  });

  it("keeps a label for every event type the inbox renders", () => {
    for (const type of [
      "comment.reply",
      "page.mention",
      "page.shared",
      "page.updated",
    ]) {
      expect(source).toContain(`"${type}":`);
    }
  });
});
