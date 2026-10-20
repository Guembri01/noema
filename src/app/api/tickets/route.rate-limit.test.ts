import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring proof for B12 — `POST /api/tickets` spends a **per-user** budget
 * that a spoofed client IP cannot dodge.
 *
 * The route resolves the session user itself and hands the id to the limiter,
 * so the budget is keyed on the user id (from the cookie) as well as on the
 * client IP. A trusted proxy is declared here on purpose: with one, every
 * request lands in its **own** client-IP bucket, so a 429 can only come from
 * the per-user budget — the spoofable address is not the reason.
 *
 * The real limiter is used (only the server actions are mocked), so this
 * covers the wiring end to end: route → api-guard → rate-limit store.
 */

const actions = vi.hoisted(() => ({
  addTicketCommentAction: vi.fn(),
  archiveTicketAction: vi.fn(),
  bulkArchiveTicketsAction: vi.fn(),
  bulkDeleteTicketsAction: vi.fn(),
  bulkUpdateTicketsAction: vi.fn(),
  createLabelAction: vi.fn(),
  createTicketAction: vi.fn(),
  deleteLabelAction: vi.fn(),
  deleteTicketAction: vi.fn(),
  linkTicketsAction: vi.fn(),
  moveTicketAction: vi.fn(),
  ticketFromPageAction: vi.fn(),
  toggleTicketLabelAction: vi.fn(),
  unlinkTicketAction: vi.fn(),
  updateLabelAction: vi.fn(),
  updateTicketAction: vi.fn(),
}));

vi.mock("@/server/actions/tickets", () => actions);
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/server/queries", () => ({
  getLabels: vi.fn(),
  getTicketsCursorPage: vi.fn(),
}));

import { POST } from "./route";
import { resetRateLimits } from "@/lib/rate-limit";

/** One write request from a caller that claims the given client IP. */
const post = (ip: string) =>
  POST(
    new Request("http://localhost/api/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ action: "delete", ticketId: "t1" }),
    }),
  );

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  actions.deleteTicketAction.mockResolvedValue({ ok: true });
  // One trusted proxy hop: the last X-Forwarded-For entry is the client
  // address the proxy saw, so every request below gets its own IP bucket.
  process.env.TRUSTED_PROXY_HOPS = "1";
});

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe("POST /api/tickets — per-user rate limit (B12)", () => {
  it("refuses a caller that rotates its ip once its own budget is spent", async () => {
    // The `tickets-write` budget is 60 per minute.
    for (let i = 0; i < 60; i += 1) {
      const res = await post(`10.0.0.${i}`);
      expect(res.status).toBe(200);
    }
    // The 61st request comes from a *different* address, so the client-IP
    // budget is untouched — the refusal can only come from the per-user
    // budget, which the caller cannot dodge by rotating its (spoofable) IP.
    const blocked = await post("10.0.0.200");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Rate limit exceeded" });
  });
});
