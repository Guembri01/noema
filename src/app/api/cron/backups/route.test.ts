import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Wiring coverage for `api/cron/backups`: the guard + rate-limit edge and the
 * real application of `src/lib/backup-retention.ts`'s GFS policy over the dump
 * files on disk (pruned dump + its manifest unlinked, kept ids reported).
 *
 * Filesystem is mocked; the policy, guard and response shaping run for real.
 */

const fs = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => fs);

import { GET } from "./route";

const SECRET = "cron-test-secret";
const URL = "http://localhost/api/cron/backups";

function call(headers: Record<string, string> = {}): Promise<Response> {
  return GET(
    new Request(URL, {
      headers: { "x-cron-secret": SECRET, "x-forwarded-for": "10.8.0.1", ...headers },
    }),
  );
}

/** Only the newest dump survives when every tier but `daily: 1` is off. */
function oneNewestOnly(): void {
  process.env.BACKUP_RETENTION_DAILY = "1";
  process.env.BACKUP_RETENTION_WEEKLY = "0";
  process.env.BACKUP_RETENTION_MONTHLY = "0";
  process.env.BACKUP_RETENTION_YEARLY = "0";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  resetRateLimits();
  process.env.CRON_SECRET = SECRET;
  delete process.env.BACKUP_DIR;
  oneNewestOnly();
  fs.stat.mockResolvedValue({ mtimeMs: 0 });
  fs.unlink.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
  delete process.env.BACKUP_RETENTION_DAILY;
  delete process.env.BACKUP_RETENTION_WEEKLY;
  delete process.env.BACKUP_RETENTION_MONTHLY;
  delete process.env.BACKUP_RETENTION_YEARLY;
});

describe("guards (characterization — must not weaken)", () => {
  it("503 when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("CRON_SECRET"),
    });
  });

  it("401 on a wrong x-cron-secret", async () => {
    const res = await call({ "x-cron-secret": "nope" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});

describe("retention — prune the dumps the policy returns", () => {
  it("keeps the newest dump and prunes the rest, manifest included", async () => {
    fs.readdir.mockResolvedValue([
      "noema-2026-01-15T00-00-00.sql",
      "noema-2026-01-14T00-00-00.sql",
      "noema-2026-01-13T00-00-00.sql",
      "notes.txt",
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      evaluated: 3,
      kept: 1,
      pruned: 2,
      policy: "Keep 1 daily backups.",
      failed: [],
    });
    expect(body.keepIds).toEqual(["noema-2026-01-15T00-00-00.sql"]);
    expect(body.pruneIds).toEqual([
      "noema-2026-01-14T00-00-00.sql",
      "noema-2026-01-13T00-00-00.sql",
    ]);

    // Each pruned dump takes its sibling manifest with it; nothing else is touched.
    expect(fs.unlink).toHaveBeenCalledTimes(4);
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("noema-2026-01-14T00-00-00.sql"));
    expect(fs.unlink).toHaveBeenCalledWith(
      expect.stringContaining("noema-2026-01-14T00-00-00.manifest.json"),
    );
    expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("noema-2026-01-15T00-00-00.sql"));
  });

  it("a missing directory is an empty pass, not an error", async () => {
    fs.readdir.mockRejectedValue(Object.assign(new Error("no such directory"), { code: "ENOENT" }));
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ evaluated: 0, kept: 0, pruned: 0, failed: [] });
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("reports a per-file unlink failure instead of throwing", async () => {
    fs.readdir.mockResolvedValue(["noema-2026-01-15T00-00-00.sql", "noema-2026-01-14T00-00-00.sql"]);
    fs.unlink.mockRejectedValue(Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" }));

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pruned).toBe(0);
    expect(body.failed).toEqual([
      { id: "noema-2026-01-14T00-00-00.sql", error: "EBUSY: locked" },
    ]);
  });
});
