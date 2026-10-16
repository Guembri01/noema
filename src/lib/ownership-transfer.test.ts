import { describe, expect, it } from "vitest";
import {
  acceptTransfer,
  auditEntry,
  cancelTransfer,
  declineTransfer,
  describeTransfer,
  expireTransfers,
  pendingFor,
  startTransfer,
  validateTransfer,
} from "@/lib/ownership-transfer";
import type { TransferRequest, TransferWorkspace } from "@/lib/ownership-transfer";

/** One hour in epoch milliseconds. */
const HOUR = 3_600_000;

/** A workspace with one member per role. */
function workspace(overrides: Partial<TransferWorkspace> = {}): TransferWorkspace {
  return {
    id: "ws-1",
    members: [
      { userId: "u-owner", role: "OWNER" },
      { userId: "u-admin", role: "ADMIN" },
      { userId: "u-member", role: "MEMBER" },
      { userId: "u-guest", role: "GUEST" },
    ],
    ...overrides,
  };
}

/** A pending request the owner opened to the admin, valid at `now = 1_000`. */
function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    id: "xfer-1",
    workspaceId: "ws-1",
    fromUserId: "u-owner",
    toUserId: "u-admin",
    initiatedAt: 1_000,
    expiresAt: 1_000 + HOUR,
    status: "pending",
    ...overrides,
  };
}

describe("startTransfer", () => {
  it("lets the owner open a pending transfer to a member", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
      id: "xfer-1",
    });
    expect(result).toEqual({
      ok: true,
      request: {
        id: "xfer-1",
        workspaceId: "ws-1",
        fromUserId: "u-owner",
        toUserId: "u-member",
        initiatedAt: 1_000,
        expiresAt: 1_000 + HOUR,
        status: "pending",
      },
    });
  });

  it("refuses an admin actor", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-admin",
      toUserId: "u-member",
      actorRole: "ADMIN",
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({
      ok: false,
      error: "Only the current owner can start an ownership transfer.",
    });
  });

  it("refuses a member actor", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-member",
      toUserId: "u-owner",
      actorRole: "MEMBER",
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({
      ok: false,
      error: "Only the current owner can start an ownership transfer.",
    });
  });

  it("refuses a caller with no role", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: null,
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({
      ok: false,
      error: "Only the current owner can start an ownership transfer.",
    });
  });

  it("accepts a lowercase owner role", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: "owner",
      now: 1_000,
      ttlMs: HOUR,
      id: "xfer-1",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a self-transfer", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-owner",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({ ok: false, error: "You already own this workspace." });
  });

  it("refuses a target who is not a member", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-stranger",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({
      ok: false,
      error: "That person is not a member of this workspace.",
    });
  });

  it("refuses a guest target", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-guest",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({
      ok: false,
      error: "A guest cannot own this workspace — promote them to a member first.",
    });
  });

  it("refuses a second pending transfer for the same workspace", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
      requests: [request()],
    });
    expect(result).toEqual({
      ok: false,
      error: "This workspace already has a pending ownership transfer.",
    });
  });

  it("ignores an expired pending transfer when enforcing the one-at-a-time rule", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
      id: "xfer-2",
      requests: [request({ expiresAt: 500 })],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.id).toBe("xfer-2");
  });

  it("refuses a non-positive window", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: "The transfer window must be a positive number of milliseconds.",
    });
  });

  it("carries requirePassword onto the request", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "u-owner",
      toUserId: "u-member",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
      id: "xfer-1",
      requirePassword: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.requirePassword).toBe(true);
  });

  it("refuses missing identifiers", () => {
    const result = startTransfer({
      workspace: workspace(),
      fromUserId: "",
      toUserId: "u-member",
      actorRole: "OWNER",
      now: 1_000,
      ttlMs: HOUR,
    });
    expect(result).toEqual({ ok: false, error: "A transfer needs a source and a target." });
  });
});

describe("acceptTransfer", () => {
  it("lets the target accept a pending request and derives the role swap", () => {
    const result = acceptTransfer(request(), { byUserId: "u-admin", now: 1_500 });
    expect(result).toEqual({
      ok: true,
      request: { ...request(), status: "accepted", acceptedAt: 1_500 },
      roleChanges: [
        { fromRole: "admin", toRole: "owner" },
        { fromRole: "owner", toRole: "admin" },
      ],
    });
  });

  it("derives the target's promotion from their current role", () => {
    const result = acceptTransfer(request({ toUserId: "u-member" }), {
      byUserId: "u-member",
      now: 1_500,
      memberRole: "MEMBER",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.roleChanges[0]).toEqual({ fromRole: "member", toRole: "owner" });
  });

  it("refuses a non-target acceptor", () => {
    const result = acceptTransfer(request(), { byUserId: "u-member", now: 1_500 });
    expect(result).toEqual({
      ok: false,
      error: "Only the intended recipient can accept this transfer.",
    });
  });

  it("refuses a request that is not pending", () => {
    const result = acceptTransfer(request({ status: "declined" }), {
      byUserId: "u-admin",
      now: 1_500,
    });
    expect(result).toEqual({ ok: false, error: "This transfer is already declined." });
  });

  it("refuses an expired request at the expiry instant", () => {
    const result = acceptTransfer(request(), { byUserId: "u-admin", now: 1_000 + HOUR });
    expect(result).toEqual({ ok: false, error: "This transfer request has expired." });
  });

  it("accepts one millisecond before expiry", () => {
    const result = acceptTransfer(request(), { byUserId: "u-admin", now: 1_000 + HOUR - 1 });
    expect(result.ok).toBe(true);
  });

  it("requires a password when the request does", () => {
    const pending = request({ requirePassword: true });
    expect(acceptTransfer(pending, { byUserId: "u-admin", now: 1_500 })).toEqual({
      ok: false,
      error: "A password is required to accept this transfer.",
    });
    expect(
      acceptTransfer(pending, { byUserId: "u-admin", now: 1_500, passwordOk: false }),
    ).toEqual({ ok: false, error: "A password is required to accept this transfer." });
  });

  it("accepts when the password checks out", () => {
    const result = acceptTransfer(request({ requirePassword: true }), {
      byUserId: "u-admin",
      now: 1_500,
      passwordOk: true,
    });
    expect(result.ok).toBe(true);
  });

  it("does not require a password when the request does not", () => {
    expect(acceptTransfer(request(), { byUserId: "u-admin", now: 1_500 }).ok).toBe(true);
  });

  it("rejects a malformed request", () => {
    const broken = { ...request(), status: "bogus" } as unknown as TransferRequest;
    expect(acceptTransfer(broken, { byUserId: "u-admin", now: 1_500 })).toEqual({
      ok: false,
      error: "That transfer request is not valid.",
    });
  });
});

describe("declineTransfer", () => {
  it("lets the target decline", () => {
    const result = declineTransfer(request(), { byUserId: "u-admin", now: 1_500 });
    expect(result).toEqual({ ok: true, request: { ...request(), status: "declined" } });
  });

  it("refuses a non-target", () => {
    const result = declineTransfer(request(), { byUserId: "u-member", now: 1_500 });
    expect(result).toEqual({
      ok: false,
      error: "Only the intended recipient can decline this transfer.",
    });
  });

  it("refuses an expired request", () => {
    const result = declineTransfer(request(), { byUserId: "u-admin", now: 1_000 + HOUR });
    expect(result).toEqual({ ok: false, error: "This transfer request has expired." });
  });
});

describe("cancelTransfer", () => {
  it("lets the sender cancel", () => {
    const result = cancelTransfer(request(), { byUserId: "u-owner", now: 1_500 });
    expect(result).toEqual({ ok: true, request: { ...request(), status: "cancelled" } });
  });

  it("refuses anyone but the sender", () => {
    const result = cancelTransfer(request(), { byUserId: "u-admin", now: 1_500 });
    expect(result).toEqual({ ok: false, error: "Only the sender can cancel this transfer." });
  });

  it("refuses an expired request", () => {
    const result = cancelTransfer(request(), { byUserId: "u-owner", now: 1_000 + HOUR });
    expect(result).toEqual({ ok: false, error: "This transfer request has expired." });
  });
});

describe("expireTransfers", () => {
  it("marks only past-expiry pending requests as expired", () => {
    const list = [
      request({ id: "a", expiresAt: 500 }),
      request({ id: "b", expiresAt: 5_000 }),
      request({ id: "c", status: "accepted", expiresAt: 500 }),
    ];
    const result = expireTransfers(list, 1_000);
    expect(result.map((entry) => entry.status)).toEqual(["expired", "pending", "accepted"]);
  });

  it("treats the expiry instant itself as expired", () => {
    const result = expireTransfers([request({ expiresAt: 1_000 })], 1_000);
    expect(result[0].status).toBe("expired");
  });

  it("does not mutate its input", () => {
    const list = [request({ expiresAt: 500 })];
    const before = JSON.stringify(list);
    expireTransfers(list, 1_000);
    expect(JSON.stringify(list)).toBe(before);
    expect(list[0].status).toBe("pending");
  });
});

describe("pendingFor", () => {
  it("returns only pending requests for the workspace", () => {
    const list = [
      request({ id: "a", workspaceId: "ws-1" }),
      request({ id: "b", workspaceId: "ws-2" }),
      request({ id: "c", workspaceId: "ws-1", status: "cancelled" }),
    ];
    expect(pendingFor(list, "ws-1").map((entry) => entry.id)).toEqual(["a"]);
  });

  it("returns nothing for an unknown workspace", () => {
    expect(pendingFor([request()], "ws-none")).toEqual([]);
  });
});

describe("validateTransfer", () => {
  it("accepts a well-formed pending request", () => {
    expect(validateTransfer(request(), { members: workspace().members, now: 1_500 })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("flags a self-transfer", () => {
    const result = validateTransfer(request({ toUserId: "u-owner" }), {
      members: workspace().members,
      now: 1_500,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("A transfer cannot target its own sender.");
  });

  it("flags a recipient who is not a member", () => {
    const result = validateTransfer(request({ toUserId: "u-stranger" }), {
      members: workspace().members,
      now: 1_500,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("The recipient is not a member of the workspace.");
  });

  it("flags a sender who is not a member", () => {
    const result = validateTransfer(request({ fromUserId: "u-stranger" }), {
      members: workspace().members,
      now: 1_500,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("The sender is not a member of the workspace.");
  });

  it("flags a pending request past its expiry", () => {
    const result = validateTransfer(request(), {
      members: workspace().members,
      now: 1_000 + HOUR,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("The transfer request has expired.");
  });

  it("flags an expiry that is not after the start", () => {
    const result = validateTransfer(request({ expiresAt: 1_000 }), {
      members: workspace().members,
      now: 1_500,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("The transfer must expire after it starts.");
  });

  it("flags an accepted request without an accepted timestamp", () => {
    const result = validateTransfer(request({ status: "accepted" }), {
      members: workspace().members,
      now: 1_500,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("An accepted transfer needs an accepted timestamp.");
  });

  it("accepts an accepted request that carries a timestamp", () => {
    const result = validateTransfer(request({ status: "accepted", acceptedAt: 1_200 }), {
      members: workspace().members,
      now: 1_500,
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("flags a malformed request", () => {
    const broken = { ...request(), status: "bogus" } as unknown as TransferRequest;
    expect(validateTransfer(broken, { members: workspace().members, now: 1_500 }).ok).toBe(false);
  });
});

describe("describeTransfer", () => {
  const nameOf = (id: string) => ({ "u-owner": "Ada", "u-admin": "Grace" })[id] ?? id;

  it("names both parties and states the status", () => {
    const text = describeTransfer(request(), { nameOf });
    expect(text).toContain("Ada → Grace");
    expect(text).toContain("(pending)");
  });

  it("includes the expiry for a pending request", () => {
    const text = describeTransfer(request(), { nameOf });
    expect(text).toContain(new Date(1_000 + HOUR).toISOString());
  });

  it("includes the acceptance time for an accepted request", () => {
    const text = describeTransfer(request({ status: "accepted", acceptedAt: 1_500 }), { nameOf });
    expect(text).toContain("(accepted)");
    expect(text).toContain(new Date(1_500).toISOString());
  });

  it("falls back to ids without a name resolver", () => {
    expect(describeTransfer(request(), {})).toContain("u-owner → u-admin");
  });
});

describe("auditEntry", () => {
  it("records an acceptance against the recipient", () => {
    expect(auditEntry(request({ status: "accepted", acceptedAt: 1_500 }), { now: 1_500 })).toEqual({
      action: "member.ownership_transferred",
      workspaceId: "ws-1",
      requestId: "xfer-1",
      actorId: "u-admin",
      targetId: "u-admin",
      status: "accepted",
      outcome: "accepted",
      at: 1_500,
    });
  });

  it("defaults a pending request to a 'started' entry by the sender", () => {
    const entry = auditEntry(request(), { now: 1_000 });
    expect(entry?.action).toBe("member.ownership_transfer_requested");
    expect(entry?.outcome).toBe("started");
    expect(entry?.actorId).toBe("u-owner");
  });

  it("records an expiry as a system action", () => {
    const entry = auditEntry(request({ status: "expired" }), { now: 2_000 });
    expect(entry?.action).toBe("member.ownership_transfer_expired");
    expect(entry?.actorId).toBe("system");
    expect(entry?.at).toBe(2_000);
  });

  it("honours an explicit outcome override", () => {
    const entry = auditEntry(request({ status: "accepted", acceptedAt: 1_500 }), {
      now: 1_500,
      outcome: "declined",
    });
    expect(entry?.action).toBe("member.ownership_transfer_declined");
    expect(entry?.outcome).toBe("declined");
  });

  it("returns null for a malformed request", () => {
    const broken = { ...request(), status: "bogus" } as unknown as TransferRequest;
    expect(auditEntry(broken, { now: 1_000 })).toBeNull();
  });
});
