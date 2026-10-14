import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * B90 — R24.18: single webhook event catalog.
 *
 * The catalog must be importable by BOTH sides — the server dispatcher
 * (`src/lib/webhooks.ts`, which owns node:crypto + prisma) and the client
 * picker (`src/components/webhook-manager.tsx`, which must stay bundle-safe).
 * These tests guard the invariants that make the extraction real:
 *
 *  1. catalog invariants: unique ids, unique labels, documented descriptions;
 *  2. server list === client dropdown list (`webhooks.ts` re-exports the very
 *     same binding — no second copy anywhere);
 *  3. grep gate: no component re-declares an event literal (the drift risk at
 *     `docs/specs/integrations-api.md` §2.3 "Catalog duplication");
 *  4. every event id matches the spec's Event catalog row.
 *
 * `@/lib/db` is mocked because `./webhooks` imports prisma at module load.
 */
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { WEBHOOK_EVENT_CATALOG, WEBHOOK_EVENTS } from "./webhook-events";
import { WEBHOOK_EVENTS as SERVER_WEBHOOK_EVENTS } from "./webhooks";

/** The client dropdown list: exactly what `webhook-manager.tsx` maps over. */
const CLIENT_DROPDOWN_IDS = WEBHOOK_EVENT_CATALOG.map((event) => event.id);

const componentsRoot = fileURLToPath(new URL("../components/", import.meta.url));
const specPath = new URL("../../docs/specs/integrations-api.md", import.meta.url);

function walkSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkSources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe("webhook event catalog — invariants (R24.18)", () => {
  it("ships the four dispatched events", () => {
    expect(CLIENT_DROPDOWN_IDS).toHaveLength(4);
  });

  it("event ids are unique", () => {
    expect(new Set(CLIENT_DROPDOWN_IDS).size).toBe(CLIENT_DROPDOWN_IDS.length);
  });

  it("labels are unique and non-empty", () => {
    const labels = WEBHOOK_EVENT_CATALOG.map((event) => event.label);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels are the wire ids — B90 ships the picker with byte-identical text", () => {
    // The dropdown has always rendered the raw `x-noema-event` value; keeping
    // label === id means this extraction changes no rendered string (R24.19
    // owns humanizing/describing picker entries).
    for (const { id, label } of WEBHOOK_EVENT_CATALOG) expect(label).toBe(id);
  });

  it("every event carries a one-line description (rendered by R24.19)", () => {
    for (const { id, description } of WEBHOOK_EVENT_CATALOG) {
      expect(typeof description, id).toBe("string");
      expect(description.trim().length, id).toBeGreaterThan(0);
    }
  });
});

describe("server list === client dropdown list (R24.18 acceptance)", () => {
  it("webhooks.ts re-exports the SAME WEBHOOK_EVENTS binding (no copied list)", () => {
    expect(SERVER_WEBHOOK_EVENTS).toBe(WEBHOOK_EVENTS);
  });

  it("the server's list deep-equals the client dropdown list, order included", () => {
    expect([...SERVER_WEBHOOK_EVENTS]).toEqual(CLIENT_DROPDOWN_IDS);
  });
});

describe("spec parity — docs/specs/integrations-api.md", () => {
  const spec = readFileSync(specPath, "utf8");

  it("catalog ids exactly match the spec's Event catalog row", () => {
    const row = spec
      .split(/\r?\n/)
      .find((line) => line.startsWith("| Event catalog |"));
    expect(row, "Event catalog row missing from integrations-api.md §2.3").toBeTruthy();
    const specIds = [...(row ?? "").matchAll(/`([a-z]+\.[a-z]+)`/g)].map((match) => match[1]);
    expect(specIds.sort()).toEqual([...CLIENT_DROPDOWN_IDS].sort());
  });
});

describe("grep gate — no second event literal in src/components/ (R24.18 acceptance)", () => {
  const sources = walkSources(componentsRoot);

  it("finds component sources to scan", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("no component quotes a catalog event id", () => {
    const offenders = sources.filter((file) => {
      const source = readFileSync(file, "utf8");
      return CLIENT_DROPDOWN_IDS.some(
        (id) => source.includes(`"${id}"`) || source.includes(`'${id}'`) || source.includes(`\`${id}\``),
      );
    });
    expect(offenders.map((file) => path.relative(componentsRoot, file))).toEqual([]);
  });

  it("no component quotes ANY event-shaped literal (id vocabulary drift)", () => {
    const eventShaped =
      /["'`](?:page|row|comment|database|view|tag|user|workspace|project|ticket|label|member|cycle|status|property|discussion|template|credential|calendar|oauth|integration)\.(?:created|updated|deleted|trashed|archived|revoked|installed)["'`]/;
    const offenders = sources.filter((file) => eventShaped.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(componentsRoot, file))).toEqual([]);
  });

  it("webhook-manager builds its dropdown from the catalog (no local EVENTS literal)", () => {
    const source = readFileSync(path.join(componentsRoot, "webhook-manager.tsx"), "utf8");
    expect(source).toContain('from "@/lib/webhook-events"');
    expect(source).toContain("WEBHOOK_EVENT_CATALOG");
    expect(source).not.toMatch(/const EVENTS\s*=/);
  });
});
