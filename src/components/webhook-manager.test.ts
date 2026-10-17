import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS11 — webhook manager adoption.
 *
 * Pure mappings (event → tag hue, delivery → badge tone, URL/form validation,
 * the test probe) are pinned here, then the real `EndpointRow` is rendered with
 * `react-dom/server` so the markup, tones and event tags are proven without a
 * DOM. `WEBHOOK_EVENT_CATALOG` supplies the event ids so this file never quotes
 * an event literal (the grep gate in `webhook-events.test.ts` scans it too).
 */

vi.mock("@/server/actions/webhooks", () => ({
  createWebhookAction: vi.fn(),
  deleteWebhookAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { WEBHOOK_EVENT_CATALOG } from "@/lib/webhook-events";
import {
  EndpointRow,
  WEBHOOK_MESSAGES,
  circuitTone,
  deliveryStatusTone,
  eventNamespace,
  eventTagHue,
  latestDelivery,
  probeWebhookEndpoint,
  subscriptionTagHue,
  validateWebhookForm,
  validateWebhookUrl,
  type DeliveryRow,
  type WebhookRow,
} from "./webhook-manager";

const [PAGE_CREATED, PAGE_UPDATED, ROW_CREATED, COMMENT_CREATED] =
  WEBHOOK_EVENT_CATALOG.map((event) => event.id);

describe("event → tag hue", () => {
  it("derives the hue from the event namespace", () => {
    expect(eventNamespace(PAGE_CREATED)).toBe("page");
    expect(eventTagHue(PAGE_CREATED)).toBe("blue");
    expect(eventTagHue(PAGE_UPDATED)).toBe("blue");
    expect(eventTagHue(ROW_CREATED)).toBe("green");
    expect(eventTagHue(COMMENT_CREATED)).toBe("purple");
  });

  it("falls back to gray for an unknown namespace or a bare id", () => {
    expect(eventNamespace("plainid")).toBe("");
    expect(eventTagHue("plainid")).toBe("gray");
    expect(eventTagHue("totally.unknown")).toBe("gray");
  });

  it("maps subscription patterns (wildcards) to hues", () => {
    expect(subscriptionTagHue("*")).toBe("gray");
    expect(subscriptionTagHue("page.*")).toBe("blue");
    expect(subscriptionTagHue(ROW_CREATED)).toBe("green");
    expect(subscriptionTagHue("nope.*")).toBe("gray");
  });
});

describe("delivery status → badge tone", () => {
  it("reads a success as success", () => {
    expect(deliveryStatusTone(true, 200)).toBe("success");
    expect(deliveryStatusTone(true, 202)).toBe("success");
  });

  it("reads a 4xx as a warning and a 5xx/transport error as danger", () => {
    expect(deliveryStatusTone(false, 404)).toBe("warning");
    expect(deliveryStatusTone(false, 429)).toBe("warning");
    expect(deliveryStatusTone(false, 500)).toBe("danger");
    expect(deliveryStatusTone(false, null)).toBe("danger");
  });

  it("maps the circuit state to a tone", () => {
    expect(circuitTone("closed")).toBe("success");
    expect(circuitTone("half-open")).toBe("warning");
    expect(circuitTone("open")).toBe("danger");
  });
});

describe("latestDelivery", () => {
  const row = (id: string, createdAt: string): DeliveryRow => ({
    id,
    event: PAGE_CREATED,
    ok: true,
    status: 200,
    attempts: 1,
    error: null,
    url: "https://hooks.example.com/noema",
    createdAt,
  });

  it("returns the newest row regardless of input order", () => {
    const older = row("a", "2024-01-01T00:00:00.000Z");
    const newer = row("b", "2024-02-01T00:00:00.000Z");
    expect(latestDelivery([older, newer])?.id).toBe("b");
    expect(latestDelivery([newer, older])?.id).toBe("b");
  });

  it("returns null for an empty set", () => {
    expect(latestDelivery([])).toBeNull();
  });
});

describe("form validation", () => {
  it("accepts a well-formed form", () => {
    const errors = validateWebhookForm({
      url: "https://example.com/hooks/noema",
      secret: "s3cret",
      events: [PAGE_CREATED, "*"],
    });
    expect(errors).toEqual({});
  });

  it("requires a url, an http(s) scheme and a signing secret", () => {
    expect(validateWebhookUrl("  ")).toBe(WEBHOOK_MESSAGES.urlRequired);
    expect(validateWebhookUrl("not a url")).toBe(WEBHOOK_MESSAGES.urlInvalid);
    expect(validateWebhookUrl("ftp://example.com")).toBe(
      WEBHOOK_MESSAGES.urlProtocol,
    );
    expect(validateWebhookUrl("https://example.com/hook")).toBeNull();

    const errors = validateWebhookForm({
      url: "ftp://example.com",
      secret: "",
      events: [],
    });
    expect(errors.url).toBe(WEBHOOK_MESSAGES.urlProtocol);
    expect(errors.secret).toBe(WEBHOOK_MESSAGES.secretRequired);
  });

  it("rejects an unknown event pattern", () => {
    const errors = validateWebhookForm({
      url: "https://example.com/hook",
      secret: "s3cret",
      events: ["totally.unknown"],
    });
    expect(errors.events).toContain("totally.unknown");
  });
});

describe("probeWebhookEndpoint", () => {
  const url = "https://example.com/hooks/noema";

  it("classifies a 2xx response as a success", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 })) as unknown as typeof fetch;
    const result = await probeWebhookEndpoint(url, fetchImpl);
    expect(result).toEqual({
      ok: true,
      status: 204,
      message: WEBHOOK_MESSAGES.testOk(204),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("classifies a non-2xx response as a failure with its status", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const result = await probeWebhookEndpoint(url, fetchImpl);
    expect(result).toEqual({
      ok: false,
      status: 502,
      message: WEBHOOK_MESSAGES.testFailed(502),
    });
  });

  it("reports an unreachable endpoint without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const result = await probeWebhookEndpoint(url, fetchImpl);
    expect(result).toEqual({
      ok: false,
      status: null,
      message: WEBHOOK_MESSAGES.testUnreachable,
    });
  });

  it("short-circuits an invalid url without calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await probeWebhookEndpoint("not a url", fetchImpl);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("EndpointRow (renderToStaticMarkup)", () => {
  const webhook: WebhookRow = {
    id: "w1",
    url: "https://hooks.example.com/noema",
    events: [PAGE_CREATED, ROW_CREATED, COMMENT_CREATED],
    hasSecret: true,
  };

  const noop = () => {};

  const render = (overrides: Partial<Parameters<typeof EndpointRow>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(EndpointRow, {
        webhook,
        health: { circuit: "closed", attemptable: true, attempts: 1 },
        latest: {
          id: "d1",
          event: PAGE_CREATED,
          ok: false,
          status: 500,
          attempts: 3,
          error: "upstream down",
          url: webhook.url,
          createdAt: "2024-02-01T00:00:00.000Z",
        },
        locale: "en",
        onTest: noop,
        onEdit: noop,
        onDelete: noop,
        ...overrides,
      }),
    );

  it("renders the url, one tag per event, the delivery badge and the actions", () => {
    const html = render();
    expect(html).toContain('data-testid="webhook-endpoint-row"');
    expect(html).toContain(webhook.url);
    // One tag per stored event, each painted from its namespace hue.
    expect(html).toContain("tag-blue");
    expect(html).toContain("tag-green");
    expect(html).toContain("tag-purple");
    // A failed 5xx delivery → danger badge; closed circuit → success; signed → neutral.
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('data-tone="success"');
    expect(html).toContain("upstream down");
    // Keyboard-parity affordances: a labelled test button and icon-only actions.
    expect(html).toContain('aria-label="Edit"');
    expect(html).toContain("Delete webhook");
  });

  it("collapses to a wildcard tag and a neutral badge when there is no history", () => {
    const html = render({
      webhook: { ...webhook, events: [], hasSecret: false },
      health: null,
      latest: null,
    });
    expect(html).toContain("tag-gray");
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain("Never");
  });

  it("surfaces a test result in a polite live region", () => {
    const html = render({
      testResult: { ok: true, status: 200, message: WEBHOOK_MESSAGES.testOk(200) },
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(WEBHOOK_MESSAGES.testOk(200));
  });
});
