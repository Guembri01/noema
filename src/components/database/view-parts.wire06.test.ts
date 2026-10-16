import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyType } from "@prisma/client";
import {
  Cell,
  buttonStepUnrunnableReason,
  nextVerificationCell,
  readRowButton,
  uniqueIdCellText,
  verificationCellView,
} from "./view-parts";
import type { DBProperty } from "@/components/database/database-types";
import { describeUniqueId } from "@/lib/unique-id";
import { toggleCell } from "@/lib/verification-cell";

/*
 * wire06 — the three property engines that existed but nothing imported are now
 * the code paths behind the UNIQUE_ID, VERIFICATION and BUTTON cells in
 * `view-parts.tsx`. These node tests pin the cell ⇄ engine mapping (the pure
 * helpers the cell delegates to) and statically render each cell so a
 * regression that re-inlines the logic fails here.
 *
 * No ambient clock: `verificationCellView` only labels; `nextVerificationCell`
 * is always handed a fixed `now`.
 */

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const ISO0 = new Date(T0).toISOString();

/** A DBProperty for a type the Prisma enum may not list yet (VERIFICATION). */
const property = (
  type: string,
  config: unknown,
  name = "Field",
  id = "p1",
): DBProperty =>
  ({
    id,
    name,
    type: type as PropertyType,
    config: config as DBProperty["config"],
  }) as DBProperty;

const render = (props: Parameters<typeof Cell>[0]) =>
  renderToStaticMarkup(createElement(Cell, props));

describe("UNIQUE_ID cell ⇄ @/lib/unique-id", () => {
  it("formats a stored counter with the property config", () => {
    const result = uniqueIdCellText({ number: 42 }, { prefix: "TASK", zeroPad: 4 });
    expect(result?.text).toBe("TASK-0042");
    expect(result?.description).toBe(
      describeUniqueId({ prefix: "TASK", zeroPad: 4 }),
    );
  });

  it("parses a stored formatted id back through the engine", () => {
    expect(uniqueIdCellText({ text: "TASK-0042" }, { prefix: "TASK", zeroPad: 4 })?.text).toBe(
      "TASK-0042",
    );
  });

  it("keeps an empty prefix like the allocator (no engine \"ID\" default)", () => {
    expect(uniqueIdCellText({ number: 7 }, undefined)?.text).toBe("-0007");
  });

  it("returns null when there is nothing the engine can format", () => {
    expect(uniqueIdCellText({}, { prefix: "TASK" })).toBeNull();
    expect(uniqueIdCellText("junk", { prefix: "TASK" })).toBeNull();
    expect(uniqueIdCellText(null, undefined)).toBeNull();
  });

  it("renders the engine text and the description tooltip", () => {
    const html = render({
      property: property("UNIQUE_ID", { uniqueId: { prefix: "TASK", zeroPad: 4 } }, "Code"),
      value: { number: 42 },
      editable: false,
      onChange: () => {},
      locale: "en",
      computed: "ROWID123",
    });
    expect(html).toContain("TASK-0042");
    expect(html).not.toContain("ROWID123");
    // React escapes the quotes inside the `title` attribute.
    expect(html).toContain(
      describeUniqueId({ prefix: "TASK", zeroPad: 4 }).replace(/"/g, "&quot;"),
    );
  });

  it("falls back to the caller-computed value when no counter exists", () => {
    const html = render({
      property: property("UNIQUE_ID", { uniqueId: { prefix: "TASK" } }, "Code"),
      value: {},
      computed: "LEGACY88",
      editable: false,
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain("LEGACY88");
  });
});

describe("VERIFICATION cell ⇄ @/lib/verification-cell", () => {
  const verifiedCell = {
    verified: true,
    verifiedById: "u1",
    verifiedAt: ISO0,
  };

  it("labels through cellDisplay (tone verified)", () => {
    const view = verificationCellView(verifiedCell);
    expect(view.label).toBe("Verified ✓ · u1 · 2026-03-01");
    expect(view.tone).toBe("verified");
    expect(view.verified).toBe(true);
  });

  it("passes the legacy display name as actorName", () => {
    expect(
      verificationCellView({ ...verifiedCell, verifiedByName: "Ada" }).label,
    ).toBe("Verified ✓ · Ada · 2026-03-01");
  });

  it("labels an empty/junk cell as not verified", () => {
    for (const raw of [{}, null, "junk", { verified: true }]) {
      const view = verificationCellView(raw);
      expect(view.label).toBe("Not verified");
      expect(view.tone).toBe("none");
      expect(view.verified).toBe(false);
    }
  });

  it("stamps the acting session user via toggleCell", () => {
    const next = nextVerificationCell({}, { actingUserId: "u9", now: T0 });
    expect(next).toEqual(toggleCell({}, { userId: "u9", now: T0 }));
    expect(next).toEqual({
      verified: true,
      verifiedById: "u9",
      verifiedAt: ISO0,
    });
  });

  it("refuses to fabricate an actor when no session id is supplied", () => {
    // Verifying with no actor is refused (the engine never stamps a blank user)…
    expect(nextVerificationCell({}, { actingUserId: undefined, now: T0 })).toEqual({
      verified: false,
      verifiedById: null,
      verifiedAt: null,
    });
    // …and a stamp left by someone else is kept, not cleared.
    expect(
      nextVerificationCell(verifiedCell, { actingUserId: undefined, now: T0 }),
    ).toEqual({
      verified: true,
      verifiedById: "u1",
      verifiedAt: ISO0,
    });
  });

  it("renders the engine label and tone on the toggle", () => {
    const html = render({
      property: property("VERIFICATION", null, "Checked"),
      value: verifiedCell,
      editable: true,
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain("Verified ✓ · u1 · 2026-03-01");
    expect(html).toContain('data-testid="verification-cell"');
    expect(html).toContain('data-tone="verified"');
  });
});

describe("BUTTON cell ⇄ @/lib/button-property", () => {
  it("adapts an editor ButtonConfig into the engine's typed action", () => {
    const source = readRowButton(
      property("BUTTON", {
        button: {
          id: "p1",
          label: "Visit",
          action: { kind: "open_url", url: "https://example.com/{{title}}" },
        },
      }),
      "Run",
    );
    expect(source?.legacy).toBe(false);
    expect(source?.label).toBe("Visit");
    expect(source?.config.actions[0]).toEqual({
      type: "open_url",
      url: "https://example.com/{{title}}",
      openInNewTab: true,
    });
  });

  it("reshapes the legacy targetPropertyId/value pair into a set_property action", () => {
    const source = readRowButton(
      property("BUTTON", { targetPropertyId: "status", value: "Done" }),
      "Run",
    );
    expect(source?.legacy).toBe(true);
    expect(source?.config.actions[0]).toEqual({
      type: "set_property",
      propertyId: "status",
      value: "Done",
    });
  });

  it("returns undefined for a button with no action (pre-engine shell)", () => {
    expect(readRowButton(property("BUTTON", null), "Run")).toBeUndefined();
    expect(readRowButton(property("BUTTON", {}), "Run")).toBeUndefined();
  });

  it("renders a runnable anchor for an open_url step", () => {
    const html = render({
      property: property(
        "BUTTON",
        {
          button: {
            id: "p1",
            label: "Visit",
            action: { kind: "open_url", url: "https://example.com/x" },
          },
        },
        "Open",
      ),
      value: {},
      editable: true,
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain(">Visit</a>");
  });

  it("renders a runnable button for a legacy set_property pair", () => {
    const html = render({
      property: property(
        "BUTTON",
        { targetPropertyId: "status", value: "Done" },
        "Mark",
      ),
      value: {},
      editable: true,
      onRunButton: () => {},
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain("<button");
    expect(html).toContain(">Run</button>");
  });

  it("gates a destructive action behind canRun and stays disabled for a viewer", () => {
    const html = render({
      property: property(
        "BUTTON",
        { button: { actions: [{ type: "delete_row" }] } },
        "Delete",
      ),
      value: {},
      editable: true,
      actingRole: "viewer",
      onRunButton: () => {},
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain('data-testid="button-cell-disabled"');
    expect(html).toContain("Your role cannot run this button.");
  });

  it("explains why an automations-only step is not runnable here", () => {
    expect(buttonStepUnrunnableReason({ kind: "notify", payload: {} as never })).toContain(
      "automations",
    );
    expect(buttonStepUnrunnableReason(undefined)).toContain("not runnable");
  });
});
