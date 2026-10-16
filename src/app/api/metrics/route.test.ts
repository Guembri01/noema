import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
   Wiring proof for GET /api/metrics: the route is fail-closed (CRON_SECRET or a
   workspace admin), and it exposes the observability snapshot, per-series
   percentiles, the Prometheus exposition and the effective feature flags in one
   machine-readable payload.
*/

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const db = vi.hoisted(() => ({
  workspaceMemberFindFirst: vi.fn(),
  workspaceFindFirst: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findFirst: db.workspaceMemberFindFirst },
    workspace: { findFirst: db.workspaceFindFirst },
  },
}));

import { GET } from "./route";
import { recordCounter, recordHistogram, resetTelemetry } from "@/lib/telemetry";

const prevSecret = process.env.CRON_SECRET;

beforeEach(() => {
  resetTelemetry();
  auth.getCurrentUser.mockReset().mockResolvedValue(null);
  db.workspaceMemberFindFirst.mockReset().mockResolvedValue(null);
  db.workspaceFindFirst.mockReset().mockResolvedValue(null);
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  if (prevSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = prevSecret;
});

function scrape(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/metrics", { headers });
}

describe("GET /api/metrics", () => {
  it("401 without a cron secret or an admin session", async () => {
    const res = await GET(scrape());
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("401 when the cron secret is wrong", async () => {
    process.env.CRON_SECRET = "top-secret";
    const res = await GET(scrape({ "x-cron-secret": "nope" }));
    expect(res.status).toBe(401);
  });

  it("200 with the x-cron-secret and a machine-readable payload", async () => {
    process.env.CRON_SECRET = "top-secret";
    recordCounter("route_test_total", { labels: { via: "test" } });
    recordHistogram("route_test_ms", 5);

    const res = await GET(scrape({ "x-cron-secret": "top-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.status).toBe("ok");
    expect(body.via).toBe("cron");
    expect(typeof body.traceId).toBe("string");
    expect(Array.isArray(body.percentiles)).toBe(true);
    expect(typeof body.prometheus).toBe("string");

    const snapshot = body.snapshot as { counters: { name: string; value: number }[] };
    expect(snapshot.counters.find((counter) => counter.name === "route_test_total")?.value).toBe(1);

    const percentiles = body.percentiles as {
      name: string;
      count: number;
      percentiles: Record<string, number>;
    }[];
    const series = percentiles.find((entry) => entry.name === "route_test_ms");
    expect(series?.count).toBe(1);
    expect(series?.percentiles.p50).toBe(5);

    const flags = body.flags as { key: string }[];
    expect(flags.map((flag) => flag.key)).toContain("diagnostics_endpoint");
  });

  it("200 for a workspace admin without any cron secret", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: "user-1" });
    db.workspaceMemberFindFirst.mockResolvedValue({ id: "member-1" });

    const res = await GET(scrape());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.via).toBe("admin");
  });

  it("200 for the owner of a workspace with no membership row", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: "user-1" });
    db.workspaceFindFirst.mockResolvedValue({ id: "ws-1" });

    const res = await GET(scrape());
    expect(res.status).toBe(200);
  });
});
