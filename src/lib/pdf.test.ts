import { describe, expect, it } from "vitest";
import { docToPdf } from "./pdf";

/**
 * `docToPdf` is the only PDF path that touches pdfkit. The print-plan suite
 * covers pagination and asset planning; this pins the renderer contract that
 * every export route depends on: a Buffer starting with `%PDF`, including for
 * text the base-14 fonts cannot encode (the Unicode-font probe either finds a
 * system face or falls back to Latin-only cleaning, but never throws).
 */
describe("docToPdf", () => {
  it("renders an ordinary document to a PDF buffer", async () => {
    const buffer = await docToPdf("Weekly notes", {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Ship the export path." }],
        },
      ],
    });
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("does not throw on accented, Cyrillic or CJK text", async () => {
    const buffer = await docToPdf("Café — Привет", {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Café déjà vu — Привет — 日本語 — 中文" },
          ],
        },
      ],
    });
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
