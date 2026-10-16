/**
 * Workspace ownership transfer engine — the pure planning half of the §8 Owner
 * role row "Modeled; transfer flows missing" (docs/FEATURE_MATRIX.md:385,
 * docs/MISSING_FEATURES.md:84).
 *
 * Handing a workspace over is a two-party consent flow, not a single write:
 * the current owner opens a request, the recipient accepts or declines, and the
 * window can lapse or be withdrawn first. The server action
 * (`transferOwnershipAction`, src/server/actions/workspaces.ts) already performs
 * the final atomic swap — owner → ADMIN, recipient → OWNER — but every guard
 * around it (who may open, who may accept, when it lapses) lives here so the UI,
 * the route and the tests share one decision table instead of re-deriving it.
 *
 * Everything in this module is pure and synchronous: no Prisma, no routes, no
 * React and no ambient clock. Callers pass `now` and the workspace roster, so a
 * transfer can be replayed against a fixed timeline in tests and the same
 * instance is deterministic. Instants are epoch milliseconds and the expiry
 * boundary itself counts as expired (fail closed, mirroring `isExpired` in
 * src/lib/invite-token.ts).
 *
 * Statuses: `pending` → `accepted` | `declined` | `cancelled` | `expired`.
 */

import { SYSTEM_ACTOR_ID } from "@/lib/audit-log";

/** The lifecycle state of a transfer request. */
export type TransferStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

/** Every status, in the order the UI lists them. */
export const TRANSFER_STATUSES: readonly TransferStatus[] = [
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled",
];

/** A two-party workspace ownership transfer proposal. */
export type TransferRequest = {
  /** Stable id for the request row. */
  id: string;
  workspaceId: string;
  /** The current owner handing ownership over. */
  fromUserId: string;
  /** The member who would become owner. */
  toUserId: string;
  /** When the request was opened (epoch millis). */
  initiatedAt: number;
  /** When the request lapses (epoch millis); the instant itself is expired. */
  expiresAt: number;
  /** When the recipient accepted (epoch millis); only set once accepted. */
  acceptedAt?: number;
  status: TransferStatus;
  /** Require the recipient to re-enter their password before accepting. */
  requirePassword?: boolean;
};

/** A workspace member, reduced to what a transfer needs. */
export type TransferMember = {
  userId: string;
  /** A `WorkspaceRole` value as a plain string, so the engine stays DB-free. */
  role: string;
};

/** The workspace a transfer is opened against. */
export type TransferWorkspace = {
  id: string;
  members: readonly TransferMember[];
};

/** Input for {@link startTransfer}; ids are `unknown` to tolerate untrusted JSON. */
export type StartTransferInput = {
  workspace: TransferWorkspace;
  fromUserId: unknown;
  toUserId: unknown;
  /** The role held by the acting owner; only `OWNER` may open a transfer. */
  actorRole: unknown;
  /** Evaluation instant and the start of the window (epoch millis). */
  now: number;
  /** Length of the acceptance window in millis. */
  ttlMs: number;
  /** Existing requests, so the one-pending-at-a-time rule can be enforced. */
  requests?: readonly TransferRequest[];
  /** Require a password before accepting. */
  requirePassword?: boolean;
  /** Explicit request id; a generated one is used when omitted. */
  id?: string;
  /** Id allocator used when `id` is omitted. */
  idFactory?: () => string;
};

/** `ok` carries the new pending request; a refusal never creates one. */
export type StartTransferResult =
  | { ok: true; request: TransferRequest }
  | { ok: false; error: string };

/** One party's role before and after an accepted transfer. */
export type RoleChange = {
  fromRole: string;
  toRole: string;
};

/** Options for {@link acceptTransfer}. */
export type AcceptTransferOptions = {
  /** The user accepting; must be the request's recipient. */
  byUserId: unknown;
  /** Evaluation instant (epoch millis). */
  now: number;
  /** Whether the re-entered password matched; required when `requirePassword`. */
  passwordOk?: boolean;
  /** The recipient's current role, for an accurate `fromRole`. Defaults to `admin`. */
  memberRole?: unknown;
};

/** `ok` carries the accepted request and the role swaps it implies. */
export type AcceptTransferResult =
  | { ok: true; request: TransferRequest; roleChanges: RoleChange[] }
  | { ok: false; error: string };

/** Options for {@link declineTransfer} / {@link cancelTransfer}. */
export type TransferActorOptions = {
  byUserId: unknown;
  now: number;
};

/** `ok` carries the updated request; a refusal never mutates it. */
export type TransferMutationResult =
  | { ok: true; request: TransferRequest }
  | { ok: false; error: string };

/** Options for {@link validateTransfer}. */
export type ValidateTransferOptions = {
  /** The workspace roster, as ids or `{ userId }` objects. */
  members?: readonly (string | { userId?: unknown })[] | null;
  /** Evaluation instant; when omitted the expiry check is skipped. */
  now?: number;
};

/** `ok` is true exactly when `errors` is empty. */
export type TransferValidation = { ok: boolean; errors: string[] };

/** Options for {@link describeTransfer}. */
export type DescribeTransferOptions = {
  /** Resolve a user id to a display name; ids are used when absent. */
  nameOf?: (userId: string) => string;
};

/** What happened to a transfer, for the audit feed. */
export type TransferAuditOutcome = "started" | "accepted" | "declined" | "cancelled" | "expired";

/** A normalised activity-log row for one transfer event. */
export type TransferAuditEntry = {
  /** Dotted action, mirroring `member.ownership_transferred`. */
  action: string;
  workspaceId: string;
  requestId: string;
  /** Who performed the outcome (system for an expiry). */
  actorId: string;
  /** The recipient the transfer targeted. */
  targetId: string;
  status: TransferStatus;
  outcome: TransferAuditOutcome;
  /** When the event happened (epoch millis). */
  at: number;
};

/** Options for {@link auditEntry}. */
export type AuditEntryOptions = {
  now: number;
  /** Defaults to the outcome implied by the request's status. */
  outcome?: TransferAuditOutcome;
};

/** The audit action recorded per outcome. */
const AUDIT_ACTIONS: Record<TransferAuditOutcome, string> = {
  started: "member.ownership_transfer_requested",
  accepted: "member.ownership_transferred",
  declined: "member.ownership_transfer_declined",
  cancelled: "member.ownership_transfer_cancelled",
  expired: "member.ownership_transfer_expired",
};

/** The outcome implied by a request's current status. */
const OUTCOME_BY_STATUS: Record<TransferStatus, TransferAuditOutcome> = {
  pending: "started",
  accepted: "accepted",
  declined: "declined",
  cancelled: "cancelled",
  expired: "expired",
};

let transferCounter = 0;

/** Default id factory: fresh, recognisable, collision-resistant within a process. */
function defaultTransferId(): string {
  transferCounter += 1;
  return `xfer_${transferCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A non-blank trimmed string, or `null` for anything else. */
function toId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** An uppercased, non-blank role string, or `null`. */
function normalizeRole(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toUpperCase();
  return role === "" ? null : role;
}

/** A lowercase role for {@link RoleChange}, or `null`. */
function lowerRole(value: unknown): string | null {
  const role = normalizeRole(value);
  return role === null ? null : role.toLowerCase();
}

/** Whether `value` is one of the five defined statuses. */
export function isTransferStatus(value: unknown): value is TransferStatus {
  return (
    typeof value === "string" && (TRANSFER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Structural guard for a transfer request: plain object with non-blank ids,
 * finite instants and a known status. `acceptedAt` and `requirePassword`, when
 * present, must be well-typed — but an accepted request without `acceptedAt` is
 * still structurally valid so {@link validateTransfer} can report it. Never
 * throws.
 */
export function isTransferRequest(value: unknown): value is TransferRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.id)) return false;
  if (!isNonEmptyString(record.workspaceId)) return false;
  if (!isNonEmptyString(record.fromUserId)) return false;
  if (!isNonEmptyString(record.toUserId)) return false;
  if (!isFiniteNumber(record.initiatedAt)) return false;
  if (!isFiniteNumber(record.expiresAt)) return false;
  if (record.acceptedAt !== undefined && !isFiniteNumber(record.acceptedAt)) return false;
  if (record.requirePassword !== undefined && typeof record.requirePassword !== "boolean") {
    return false;
  }
  return isTransferStatus(record.status);
}

/** Whether a request has lapsed at `now` (the boundary instant counts). */
export function isTransferExpired(request: TransferRequest, now: number): boolean {
  return now >= request.expiresAt;
}

/** The member row for `userId`, or `null` when they are not a member. */
function findMember(
  members: readonly TransferMember[],
  userId: string,
): TransferMember | null {
  for (const member of members) {
    if (member && typeof member === "object" && member.userId === userId) return member;
  }
  return null;
}

/** Collect the ids in a roster of strings / `{ userId }` objects. */
function memberIdSet(
  members: readonly (string | { userId?: unknown })[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const member of members ?? []) {
    const id =
      typeof member === "string"
        ? toId(member)
        : member !== null && typeof member === "object"
          ? toId((member as { userId?: unknown }).userId)
          : null;
    if (id !== null) ids.add(id);
  }
  return ids;
}

/**
 * Open an ownership transfer from `fromUserId` to `toUserId`.
 *
 * Refuses — with a readable `error` and no request — when the acting role is
 * not the owner, the source and target are the same person, the target is not a
 * member, the target is a guest (mirroring `transferOwnershipAction`), the
 * window is not a positive number of milliseconds, or the workspace already has
 * a live pending transfer. Stale (expired) requests are lapsed first, so they
 * never block a new one. On success the request is `pending` with
 * `expiresAt = now + ttlMs`.
 */
export function startTransfer(input: StartTransferInput): StartTransferResult {
  const workspace = input?.workspace;
  if (!workspace || typeof workspace !== "object" || !isNonEmptyString(workspace.id)) {
    return { ok: false, error: "A workspace with an id is required." };
  }
  const fromUserId = toId(input.fromUserId);
  const toUserId = toId(input.toUserId);
  if (fromUserId === null || toUserId === null) {
    return { ok: false, error: "A transfer needs a source and a target." };
  }
  if (normalizeRole(input.actorRole) !== "OWNER") {
    return { ok: false, error: "Only the current owner can start an ownership transfer." };
  }
  if (fromUserId === toUserId) {
    return { ok: false, error: "You already own this workspace." };
  }
  const target = findMember(workspace.members ?? [], toUserId);
  if (!target) {
    return { ok: false, error: "That person is not a member of this workspace." };
  }
  if (normalizeRole(target.role) === "GUEST") {
    return {
      ok: false,
      error: "A guest cannot own this workspace — promote them to a member first.",
    };
  }
  if (!isFiniteNumber(input.now)) {
    return { ok: false, error: "An evaluation instant is required." };
  }
  if (!isFiniteNumber(input.ttlMs) || input.ttlMs <= 0) {
    return {
      ok: false,
      error: "The transfer window must be a positive number of milliseconds.",
    };
  }
  const now = input.now;
  const live = expireTransfers(input.requests ?? [], now);
  if (pendingFor(live, workspace.id).length > 0) {
    return { ok: false, error: "This workspace already has a pending ownership transfer." };
  }

  const id = isNonEmptyString(input.id)
    ? input.id
    : (input.idFactory ?? defaultTransferId)();
  const request: TransferRequest = {
    id,
    workspaceId: workspace.id,
    fromUserId,
    toUserId,
    initiatedAt: now,
    expiresAt: now + input.ttlMs,
    status: "pending",
  };
  if (input.requirePassword === true) request.requirePassword = true;
  return { ok: true, request };
}

/**
 * Accept a pending transfer as its recipient.
 *
 * Refuses when the request is malformed, is no longer pending, is being
 * accepted by anyone but `toUserId`, has lapsed at `now`, or requires a
 * password that was not confirmed (`passwordOk !== true`). On success the
 * request becomes `accepted` with `acceptedAt = now`, and `roleChanges` lists
 * the recipient's promotion first (`{ fromRole: <current>, toRole: "owner" }`,
 * defaulting the current role to `admin`) then the previous owner's demotion
 * (`{ fromRole: "owner", toRole: "admin" }`), matching the atomic swap in
 * `transferOwnershipAction`.
 */
export function acceptTransfer(
  request: TransferRequest,
  options: AcceptTransferOptions,
): AcceptTransferResult {
  const invalid = transferPreconditionError(request, options?.byUserId, options?.now, "accept");
  if (invalid !== null) return { ok: false, error: invalid };
  if (request.requirePassword === true && options.passwordOk !== true) {
    return { ok: false, error: "A password is required to accept this transfer." };
  }
  const targetRole = lowerRole(options.memberRole) ?? "admin";
  const accepted: TransferRequest = { ...request, status: "accepted", acceptedAt: options.now };
  const roleChanges: RoleChange[] = [
    { fromRole: targetRole, toRole: "owner" },
    { fromRole: "owner", toRole: "admin" },
  ];
  return { ok: true, request: accepted, roleChanges };
}

/**
 * Decline a pending transfer as its recipient. Refuses a non-recipient, a
 * non-pending request and an expired one. On success the request becomes
 * `declined`; the input is never mutated.
 */
export function declineTransfer(
  request: TransferRequest,
  options: TransferActorOptions,
): TransferMutationResult {
  const invalid = transferPreconditionError(request, options?.byUserId, options?.now, "decline");
  if (invalid !== null) return { ok: false, error: invalid };
  return { ok: true, request: { ...request, status: "declined" } };
}

/**
 * Withdraw a pending transfer as its sender. Refuses anyone but `fromUserId`,
 * a non-pending request and an expired one. On success the request becomes
 * `cancelled`; the input is never mutated.
 */
export function cancelTransfer(
  request: TransferRequest,
  options: TransferActorOptions,
): TransferMutationResult {
  const invalid = transferPreconditionError(request, options?.byUserId, options?.now, "cancel");
  if (invalid !== null) return { ok: false, error: invalid };
  return { ok: true, request: { ...request, status: "cancelled" } };
}

/** Which party may resolve a pending request. */
type TransferResolveAction = "accept" | "decline" | "cancel";

/** The first reason a resolve action is refused, or `null` when it may proceed. */
function transferPreconditionError(
  request: unknown,
  byUserId: unknown,
  now: unknown,
  action: TransferResolveAction,
): string | null {
  if (!isTransferRequest(request)) return "That transfer request is not valid.";
  if (request.status !== "pending") return `This transfer is already ${request.status}.`;
  const actor = toId(byUserId);
  if (action === "cancel") {
    if (actor === null || actor !== request.fromUserId) {
      return "Only the sender can cancel this transfer.";
    }
  } else if (actor === null || actor !== request.toUserId) {
    return action === "accept"
      ? "Only the intended recipient can accept this transfer."
      : "Only the intended recipient can decline this transfer.";
  }
  if (isFiniteNumber(now) && isTransferExpired(request, now)) {
    return "This transfer request has expired.";
  }
  return null;
}

/**
 * Lapse every pending request whose window has closed at `now`, leaving every
 * other row untouched. Pure: changed rows are copied and the input array and
 * its members are never mutated.
 */
export function expireTransfers(
  requests: readonly TransferRequest[],
  now: number,
): TransferRequest[] {
  const list = Array.isArray(requests) ? requests : [];
  return list.map((request) =>
    isTransferRequest(request) && request.status === "pending" && isTransferExpired(request, now)
      ? { ...request, status: "expired" }
      : request,
  );
}

/**
 * Every still-`pending` request for `workspaceId`, in input order. Purely
 * status-based: run {@link expireTransfers} first if time-awareness is wanted.
 */
export function pendingFor(
  requests: readonly TransferRequest[],
  workspaceId: string,
): TransferRequest[] {
  const list = Array.isArray(requests) ? requests : [];
  return list.filter(
    (request) =>
      isTransferRequest(request) &&
      request.status === "pending" &&
      request.workspaceId === workspaceId,
  );
}

/**
 * Check a request for internal consistency and membership:
 *
 * - the recipient differs from the sender (`A transfer cannot target its own
 *   sender.`);
 * - both parties are members of the supplied roster;
 * - `expiresAt` is strictly after `initiatedAt`;
 * - a still-pending request has not lapsed at `now`;
 * - an accepted request carries `acceptedAt`.
 *
 * `ok` is true exactly when the error list is empty; `now` may be omitted to
 * skip the expiry check. Never throws.
 */
export function validateTransfer(
  request: TransferRequest,
  options: ValidateTransferOptions = {},
): TransferValidation {
  if (!isTransferRequest(request)) {
    return { ok: false, errors: ["The transfer request is not valid."] };
  }
  const errors: string[] = [];

  if (request.fromUserId === request.toUserId) {
    errors.push("A transfer cannot target its own sender.");
  }
  const members = memberIdSet(options.members);
  if (options.members !== undefined && options.members !== null) {
    if (!members.has(request.fromUserId)) {
      errors.push("The sender is not a member of the workspace.");
    }
    if (!members.has(request.toUserId)) {
      errors.push("The recipient is not a member of the workspace.");
    }
  }
  if (request.expiresAt <= request.initiatedAt) {
    errors.push("The transfer must expire after it starts.");
  }
  if (request.status === "pending" && isFiniteNumber(options.now) && isTransferExpired(request, options.now)) {
    errors.push("The transfer request has expired.");
  }
  if (request.status === "accepted" && !isFiniteNumber(request.acceptedAt)) {
    errors.push("An accepted transfer needs an accepted timestamp.");
  }

  return { ok: errors.length === 0, errors };
}

/** Render an epoch-millis instant as an ISO-8601 UTC string. */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * A human-facing one-liner, e.g. `"Ada → Grace: transfer ownership of ws-1
 * (pending), expires 1970-01-01T01:00:00.000Z"`. Names come from `nameOf` and
 * fall back to ids; a pending request appends its expiry and an accepted one
 * its acceptance time.
 */
export function describeTransfer(
  request: TransferRequest,
  options: DescribeTransferOptions = {},
): string {
  const nameOf = typeof options.nameOf === "function" ? options.nameOf : null;
  const resolve = (id: string): string => {
    const named = nameOf ? nameOf(id) : id;
    return isNonEmptyString(named) ? named : id;
  };
  const base = `${resolve(request.fromUserId)} → ${resolve(request.toUserId)}: transfer ownership of ${request.workspaceId} (${request.status})`;
  if (request.status === "pending" && isFiniteNumber(request.expiresAt)) {
    return `${base}, expires ${toIso(request.expiresAt)}`;
  }
  if (request.status === "accepted" && isFiniteNumber(request.acceptedAt)) {
    return `${base}, accepted ${toIso(request.acceptedAt)}`;
  }
  return base;
}

/**
 * Normalise a transfer event into an activity-log row. The outcome defaults to
 * the one implied by the request's status, and the actor follows the outcome:
 * the recipient accepts/declines, the sender starts/cancels, and an expiry is
 * attributed to {@link SYSTEM_ACTOR_ID}. Returns `null` for a malformed
 * request; never throws.
 */
export function auditEntry(
  request: TransferRequest,
  options: AuditEntryOptions = { now: request.initiatedAt },
): TransferAuditEntry | null {
  if (!isTransferRequest(request)) return null;
  const outcome = options.outcome ?? OUTCOME_BY_STATUS[request.status];
  const actorId =
    outcome === "expired"
      ? SYSTEM_ACTOR_ID
      : outcome === "accepted" || outcome === "declined"
        ? request.toUserId
        : request.fromUserId;
  return {
    action: AUDIT_ACTIONS[outcome],
    workspaceId: request.workspaceId,
    requestId: request.id,
    actorId,
    targetId: request.toUserId,
    status: request.status,
    outcome,
    at: isFiniteNumber(options.now) ? options.now : request.initiatedAt,
  };
}
