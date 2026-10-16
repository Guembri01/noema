import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { SharePermission } from "@prisma/client";
import { middleware } from "../middleware";
import { PartialWriteError, type WriteResult } from "./atomic-writes";
import { WorkspaceScopeError } from "./tenant-scope";
import { TenancyError } from "./tenancy";
import type { PageGrant } from "./access-inheritance";
import {
  AccessDeniedError,
  accessAllows,
  assertPageAccess,
  assertRowScoped,
  assertRowsScoped,
  assertWorkspaceMatch,
  auditScopedRows,
  decideIpAllowlist,
  filterScopedRows,
  headerClientIp,
  isPrivateSurface,
  isScoped,
  parseIpAllowlist,
  planScopedWrites,
  resolveAccess,
  runAtomicWrites,
  scopeByWorkspace,
  scopedWhere,
  validateScopedWrites,
  type GuardedWriteStep,
} from "./tenant-guard";

/**
 * Wiring proof for the tenant guard — the seam that makes the previously
 * unreachable hardening engines load-bearing:
 *
 *  - `tenancy.ts` (scope enforcement),
 *  - `atomic-writes.ts` + `tenant-scope.ts` (retry + partial-write audit),
 *  - `access-inheritance.ts` (inheritance resolution),
 *  - `ip-allowlist.ts` (allowlist decisions),
 *  - and `src/middleware.ts`, which enforces the allowlist on private surfaces.
 *
 * No DB, no network, no real clock: every side effect is injected, so the
 * fail-closed rules are proven deterministically.
 */

/* ------------------------------------------------------------------ *
 * Scope enforcement (tenancy.ts, canonical)
 * ------------------------------------------------------------------ */

type Row = { id: string; workspaceId?: unknown };
const row = (id: string, workspaceId: unknown): Row => ({ id, workspaceId });

describe("scope enforcement (canonical tenancy via the guard)", () => {
  it("builds a workspace-pinned where", () => {
    expect(scopedWhere({ workspaceId: "ws1" })).toEqual({ workspaceId: "ws1" });
    expect(scopedWhere({ workspaceId: "ws1", userId: "u1" })).toEqual({
      workspaceId: "ws1",
      userId: "u1",
    });
  });

  it("throws on a blank/unknown scope and never emits an unscoped where", () => {
    for (const bad of ["", "   ", null, undefined, 3]) {
      expect(() => scopedWhere({ workspaceId: bad as unknown as string })).toThrow(TenancyError);
    }
  });

  it("assertRowScoped returns owned rows and refuses cross-workspace rows", () => {
    const owned = row("a", "ws1");
    expect(assertRowScoped(owned, { workspaceId: "ws1" })).toBe(owned);
    expect(() => assertRowScoped(row("a", "ws2"), { workspaceId: "ws1" })).toThrow(TenancyError);
  });

  it("scopes the top-level field, so a nested match cannot smuggle a row", () => {
    expect(() => assertRowScoped({ id: "a" }, { workspaceId: "ws1" })).toThrow(TenancyError);
    expect(() =>
      assertRowScoped({ id: "a", workspaceId: "ws2", parent: { workspaceId: "ws1" } }, { workspaceId: "ws1" }),
    ).toThrow(TenancyError);
  });

  it("filterScopedRows keeps only the workspace rows, order preserved", () => {
    const rows = [row("a", "ws1"), row("b", "ws2"), row("c", "ws1")];
    expect(filterScopedRows(rows, { workspaceId: "ws1" }).map((entry) => entry.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("auditScopedRows reports offenses without leaking the foreign id", () => {
    const offenses = auditScopedRows(
      [row("a", "ws1"), row("b", "ws2"), { id: "c" }],
      { workspaceId: "ws1" },
    );
    expect(offenses).toEqual([
      { index: 1, reason: "foreign-workspace" },
      { index: 2, reason: "missing-workspace" },
    ]);
    expect(JSON.stringify(offenses)).not.toContain("ws2");
  });

  it("assertRowsScoped throws a coded error on offenders and passes clean rows", () => {
    try {
      assertRowsScoped([row("a", "ws2")], { workspaceId: "ws1" });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TenancyError);
      expect((error as TenancyError).code).toBe("TENANCY_VIOLATION");
    }
    expect(() => assertRowsScoped([row("a", "ws1")], { workspaceId: "ws1" })).not.toThrow();
  });

  it("isScoped detects a workspace filter and rejects an unscoped clause", () => {
    expect(isScoped({ workspaceId: "ws1" })).toBe(true);
    expect(isScoped({ AND: [{ workspaceId: "ws1" }, { deletedAt: null }] })).toBe(true);
    expect(isScoped({ userId: "u1" })).toBe(false);
  });

  it("tenant-scope adapters delegate to the canonical engine", () => {
    const rows = [row("a", "ws1"), row("b", "ws2")];
    expect(scopeByWorkspace(rows, "ws1").map((entry) => entry.id)).toEqual(["a"]);
    expect(assertWorkspaceMatch(row("a", "ws1"), "ws1")).toEqual(row("a", "ws1"));
    expect(() => assertWorkspaceMatch(row("a", "ws2"), "ws1")).toThrow(TenancyError);
  });

  it("plans a single-workspace batch and refuses a cross-workspace one", () => {
    const plan = planScopedWrites(
      [{ model: "Page", operation: "create", workspaceId: "ws1" }],
      "ws1",
    );
    expect(plan.count).toBe(1);
    expect(() =>
      planScopedWrites([{ model: "Page", operation: "create", workspaceId: "ws2" }], "ws1"),
    ).toThrow(WorkspaceScopeError);
    expect(
      validateScopedWrites([{ model: "Page", operation: "create", workspaceId: "ws2" }], "ws1")[0]
        ?.reason,
    ).toBe("foreign-workspace");
  });
});

/* ------------------------------------------------------------------ *
 * Atomic multi-step writes + retry (atomic-writes.ts + tenant-scope.ts)
 * ------------------------------------------------------------------ */

const step = (id: string, extra: Partial<GuardedWriteStep> = {}): GuardedWriteStep => ({
  id,
  model: "Page",
  operation: "create",
  workspaceId: "ws1",
  run: async () => undefined,
  ...extra,
});

describe("runAtomicWrites — planning, retry and partial-write audit", () => {
  it("orders dependent steps and returns a consistent report", async () => {
    const seen: string[][] = [];
    const outcome = await runAtomicWrites(
      { workspaceId: "ws1" },
      [step("block", { dependsOn: ["page"] }), step("page")],
      async (statements) => {
        seen.push(statements.map((statement) => statement.id));
        return statements.map((statement) => ({ id: statement.id, ok: true }));
      },
    );
    expect(seen).toEqual([["page", "block"]]);
    expect(outcome.plan.ids).toEqual(["page", "block"]);
    expect(outcome.report.consistent).toBe(true);
    expect(outcome.report.committed).toEqual(["page", "block"]);
  });

  it("refuses a cross-workspace batch before invoking the executor", async () => {
    let ran = 0;
    await expect(
      runAtomicWrites({ workspaceId: "ws1" }, [step("a", { workspaceId: "ws2" })], async () => {
        ran += 1;
        return [];
      }),
    ).rejects.toBeInstanceOf(WorkspaceScopeError);
    expect(ran).toBe(0);
  });

  it("retries a transient conflict then succeeds", async () => {
    let calls = 0;
    const outcome = await runAtomicWrites(
      { workspaceId: "ws1" },
      [step("a")],
      async (statements) => {
        calls += 1;
        if (calls < 2) throw new Error("Transaction failed due to a write conflict or a deadlock");
        return statements.map((statement) => ({ id: statement.id, ok: true }));
      },
      { attempts: 3, baseDelayMs: 10, sleep: async () => {} },
    );
    expect(calls).toBe(2);
    expect(outcome.report.consistent).toBe(true);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      runAtomicWrites(
        { workspaceId: "ws1" },
        [step("a")],
        async () => {
          calls += 1;
          throw new Error("Record to update not found.");
        },
        {
          attempts: 4,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toThrow("Record to update not found.");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("throws PartialWriteError when the executor half-applies a batch", async () => {
    const results: WriteResult[] = [
      { id: "a", ok: true },
      { id: "b", ok: false },
    ];
    try {
      await runAtomicWrites({ workspaceId: "ws1" }, [step("a"), step("b")], async () => results);
      expect.unreachable("expected PartialWriteError");
    } catch (error) {
      expect(error).toBeInstanceOf(PartialWriteError);
      expect((error as PartialWriteError).report.conflicts).toEqual(["a"]);
      expect((error as PartialWriteError).report.failed).toEqual(["b"]);
    }
  });

  it("rejects duplicate ids and dependency cycles", async () => {
    await expect(
      runAtomicWrites({ workspaceId: "ws1" }, [step("a"), step("a")], async () => []),
    ).rejects.toThrow();
    await expect(
      runAtomicWrites(
        { workspaceId: "ws1" },
        [step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })],
        async () => [],
      ),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Inheritance resolution (access-inheritance.ts)
 * ------------------------------------------------------------------ */

const PAGE = { id: "leaf" };
const ANCESTRY = ["mid", "root"];

describe("access resolution (inheritance via the guard)", () => {
  it("resolves a grant inherited from an ancestor for a member", () => {
    expect(
      resolveAccess({
        user: { id: "u1", role: "MEMBER" },
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [{ pageId: "mid", userId: "u1", level: "COMMENT" }],
      }),
    ).toBe("COMMENT");
  });

  it("gives an admin the FULL role baseline with no grants", () => {
    expect(resolveAccess({ user: { id: "u1", role: "ADMIN" }, page: PAGE, ancestry: ANCESTRY })).toBe(
      "FULL",
    );
  });

  it("fails closed with no grant, no inheritance and no link", () => {
    expect(
      resolveAccess({ user: { id: "u1", role: "MEMBER" }, page: PAGE, ancestry: ANCESTRY }),
    ).toBeNull();
    expect(resolveAccess({ user: null, page: PAGE, ancestry: ANCESTRY })).toBeNull();
  });

  it("accessAllows ranks levels and denies null/forged values", () => {
    expect(accessAllows("EDIT", "READ")).toBe(true);
    expect(accessAllows("READ", "EDIT")).toBe(false);
    expect(accessAllows(null, "READ")).toBe(false);
    expect(accessAllows("OWN" as unknown as SharePermission, "READ")).toBe(false);
  });

  it("assertPageAccess returns the level or throws AccessDeniedError", () => {
    const grants: PageGrant[] = [{ pageId: "leaf", userId: "u1", level: "EDIT" }];
    expect(
      assertPageAccess(
        { user: { id: "u1", role: "MEMBER" }, page: PAGE, ancestry: ANCESTRY, grants },
        "COMMENT",
      ),
    ).toBe("EDIT");

    try {
      assertPageAccess(
        { user: { id: "u1", role: "MEMBER" }, page: PAGE, ancestry: ANCESTRY, grants },
        "FULL",
      );
      expect.unreachable("expected AccessDeniedError");
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).status).toBe(403);
      expect((error as AccessDeniedError).required).toBe("FULL");
    }
  });
});

/* ------------------------------------------------------------------ *
 * IP allowlist (ip-allowlist.ts)
 * ------------------------------------------------------------------ */

describe("IP allowlist decisions", () => {
  it("parseIpAllowlist drops junk and dedupes across commas/whitespace", () => {
    expect(parseIpAllowlist(" 10.0.0.0/8, 192.168.0.0/16 10.0.0.0/8, nope ")).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
    ]);
    expect(parseIpAllowlist(undefined)).toEqual([]);
    expect(parseIpAllowlist("")).toEqual([]);
  });

  it("is open when not configured", () => {
    expect(decideIpAllowlist("203.0.113.9", [])).toMatchObject({
      allowed: true,
      configured: false,
      reason: "not-configured",
    });
  });

  it("allows a matching client and denies a non-matching one", () => {
    expect(decideIpAllowlist("10.1.2.3", ["10.0.0.0/8"])).toMatchObject({
      allowed: true,
      configured: true,
      reason: "allowed",
      clientIp: "10.1.2.3",
    });
    expect(decideIpAllowlist("203.0.113.9", ["10.0.0.0/8"])).toMatchObject({
      allowed: false,
      configured: true,
      reason: "denied",
    });
  });

  it("fails closed on a missing or malformed client ip once configured", () => {
    expect(decideIpAllowlist(null, ["10.0.0.0/8"]).allowed).toBe(false);
    expect(decideIpAllowlist("not-an-ip", ["10.0.0.0/8"]).allowed).toBe(false);
    expect(decideIpAllowlist(undefined, ["2001:db8::/32"]).allowed).toBe(false);
  });

  it("matches IPv6 ranges too", () => {
    expect(decideIpAllowlist("2001:db8::5", ["2001:db8::/32"]).allowed).toBe(true);
  });

  it("headerClientIp prefers the first forwarded hop, then x-real-ip", () => {
    expect(headerClientIp((name) => (name === "x-forwarded-for" ? "10.1.2.3, 10.9.9.9" : null))).toBe(
      "10.1.2.3",
    );
    expect(headerClientIp((name) => (name === "x-real-ip" ? "10.1.2.3" : null))).toBe("10.1.2.3");
    expect(headerClientIp(() => null)).toBeNull();
  });

  it("isPrivateSurface flags settings/audit/admin only", () => {
    for (const path of [
      "/w/acme/settings",
      "/w/acme/settings/billing",
      "/w/acme/audit",
      "/w/acme/audit/export",
      "/admin",
      "/admin/users",
    ]) {
      expect(isPrivateSurface(path), path).toBe(true);
    }
    for (const path of [
      "/w/acme",
      "/w/acme/some-page",
      "/w/acme/settingsX",
      "/login",
      "/api/pages",
    ]) {
      expect(isPrivateSurface(path), path).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Middleware enforcement (src/middleware.ts)
 * ------------------------------------------------------------------ */

describe("middleware IP gate on private surfaces", () => {
  const ENV = ["ADMIN_IP_ALLOWLIST", "PRIVATE_IP_ALLOWLIST"] as const;
  const saved = ENV.map((name) => [name, process.env[name]] as const);
  const clear = () => {
    for (const name of ENV) delete process.env[name];
  };

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("leaves private surfaces open when unconfigured", () => {
    clear();
    const res = middleware(new NextRequest("http://localhost:3201/w/acme/settings"));
    expect(res.status).not.toBe(403);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("blocks a non-allowlisted IP and admits an allowlisted one", () => {
    clear();
    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";
    try {
      const denied = middleware(
        new NextRequest("http://localhost:3201/w/acme/settings", {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
      );
      expect(denied.status).toBe(403);

      const allowed = middleware(
        new NextRequest("http://localhost:3201/w/acme/settings", {
          headers: { "x-forwarded-for": "10.1.2.3" },
        }),
      );
      expect(allowed.status).not.toBe(403);
      expect(allowed.headers.get("Content-Security-Policy")).toBeTruthy();
    } finally {
      clear();
    }
  });

  it("does not gate public surfaces even when configured", () => {
    clear();
    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";
    try {
      const res = middleware(
        new NextRequest("http://localhost:3201/login", {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
      );
      expect(res.status).not.toBe(403);
    } finally {
      clear();
    }
  });

  it("fails closed on a configured but entirely invalid allowlist", () => {
    clear();
    process.env.ADMIN_IP_ALLOWLIST = "not-a-cidr";
    try {
      const res = middleware(
        new NextRequest("http://localhost:3201/admin", {
          headers: { "x-forwarded-for": "10.1.2.3" },
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      clear();
    }
  });
});
