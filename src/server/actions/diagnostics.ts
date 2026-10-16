"use server";

/**
 * Diagnostics server actions — the production sink that makes the pure error
 * and feature-flag cores reachable.
 *
 * Two async entry points (the only thing a `"use server"` module may export):
 *
 * - {@link reportClientErrorAction} is called by the client error boundary
 *   (`src/app/error.tsx`). The boundary has already done the client-side work
 *   (`normalizeError` / `fingerprint` / `shouldSample` / `toBreadcrumb` from
 *   `error-tracking.ts`); this action groups the arrival server-side with
 *   `groupErrors` + `buildReport` and reuses `error-reporting.ts`'s
 *   `redactSecrets` scrubber over the grouped payload — the two error modules
 *   are reconciled rather than duplicated (error-tracking owns normalisation and
 *   grouping, error-reporting owns the broad payload scrubber).
 * - {@link getDiagnosticsAction} reads/lists the effective feature flags through
 *   `telemetry.ts`, which is the registry/resolver façade over
 *   `feature-flag-store.ts`.
 *
 * Deliberately no Prisma and no auth here: the sink is bounded in-memory state,
 * so it is safe to call from an unauthenticated browser boundary and cheap to
 * unit-test.
 */

import {
  buildReport,
  groupErrors,
  type ErrorEvent,
  type ErrorReport,
  type Severity,
} from "@/lib/error-tracking";
import { redactSecrets } from "@/lib/error-reporting";
import {
  effectiveFlags,
  flagSnapshot,
  log,
  recordCounter,
} from "@/lib/telemetry";
import type { FlagStoreSnapshot } from "@/lib/feature-flag-store";

/* -------------------------------------------------------------------------- */
/* Input coercion                                                             */
/* -------------------------------------------------------------------------- */

/** Non-null, non-array object — the only shape trusted as a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, else `undefined`. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite number, else `undefined`. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Coerce one untrusted payload entry into an `ErrorEvent`. The boundary sends a
 * serialisable `{ error, route, action, timestamp, fingerprint, id }`; a bare
 * value (string, number, object) is treated as the thrown error itself.
 */
function toErrorEvent(raw: unknown): ErrorEvent | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return { error: raw };

  const id = asString(raw.id);
  const route = asString(raw.route);
  const action = asString(raw.action);
  const fingerprintValue = asString(raw.fingerprint);
  const timestamp = asFiniteNumber(raw.timestamp);
  const errorValue = isRecord(raw.error) ? raw.error : raw;

  return {
    error: errorValue,
    ...(id !== undefined ? { id } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(fingerprintValue !== undefined ? { fingerprint: fingerprintValue } : {}),
  };
}

/** Accept a single event or a batch, dropping unusable entries. */
function coerceEvents(input: unknown): readonly ErrorEvent[] {
  const list = Array.isArray(input) ? input : [input];
  const events: ErrorEvent[] = [];
  for (const entry of list) {
    const event = toErrorEvent(entry);
    if (event !== null) events.push(event);
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/* Client error reporting                                                     */
/* -------------------------------------------------------------------------- */

const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Rebuild a typed `ErrorReport` after `redactSecrets` has walked it, reusing
 * error-reporting's scrubber instead of a second redaction implementation.
 */
function scrubReport(report: ErrorReport): ErrorReport {
  const scrubbed = redactSecrets(report);
  if (!isRecord(scrubbed)) return report;
  const sampleIds = Array.isArray(scrubbed.sampleIds)
    ? scrubbed.sampleIds.filter((id): id is string => typeof id === "string")
    : report.sampleIds;
  return {
    fingerprint: asString(scrubbed.fingerprint) ?? report.fingerprint,
    severity: isSeverity(scrubbed.severity) ? scrubbed.severity : report.severity,
    count: asFiniteNumber(scrubbed.count) ?? report.count,
    firstSeen: asFiniteNumber(scrubbed.firstSeen) ?? report.firstSeen,
    lastSeen: asFiniteNumber(scrubbed.lastSeen) ?? report.lastSeen,
    sampleIds,
    title: asString(scrubbed.title) ?? report.title,
  };
}

/** Result of {@link reportClientErrorAction}; safe to serialise to the client. */
export type ClientErrorResult =
  | { readonly ok: true; readonly received: number; readonly groups: readonly ErrorReport[] }
  | { readonly ok: false; readonly error: string };

/**
 * Group a captured client error (or batch) by fingerprint and return the
 * redacted triage reports, most frequent first. Never throws: a hostile payload
 * is coerced, and grouping/building are total.
 */
export async function reportClientErrorAction(input: unknown): Promise<ClientErrorResult> {
  const events = coerceEvents(input);
  if (events.length === 0) {
    return { ok: false, error: "No error event provided." };
  }

  const groups = groupErrors(events).map(buildReport).map(scrubReport);

  recordCounter("client_error_events_total", { amount: events.length });
  recordCounter("client_error_groups_total", { amount: groups.length });
  log("warn", "diagnostics.client_error", {
    received: events.length,
    groups: groups.length,
  });

  return { ok: true, received: events.length, groups };
}

/* -------------------------------------------------------------------------- */
/* Feature-flag diagnostics                                                   */
/* -------------------------------------------------------------------------- */

/** One effective flag, reduced to the fields a diagnostic reader needs. */
export type DiagnosticsFlag = {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason: string;
  readonly source: string;
};

/** The read-only diagnostics payload returned by {@link getDiagnosticsAction}. */
export type DiagnosticsPayload = {
  readonly ok: true;
  readonly generatedAt: number;
  readonly uptimeSeconds: number;
  readonly flags: readonly DiagnosticsFlag[];
  readonly flagStore: FlagStoreSnapshot;
};

/**
 * Read the effective feature flags server-side. Both the resolved decisions and
 * the raw store snapshot are surfaced so a UI can show *why* a flag is on (the
 * `source` layer) and what the registry/override layers hold.
 */
export async function getDiagnosticsAction(): Promise<DiagnosticsPayload> {
  const flags = effectiveFlags();
  const store = flagSnapshot();
  recordCounter("diagnostics_reads_total");

  return {
    ok: true,
    generatedAt: Date.now(),
    uptimeSeconds: Math.round(process.uptime()),
    flags: flags.map((flag) => ({
      key: flag.key,
      enabled: flag.enabled,
      reason: flag.reason,
      source: flag.source,
    })),
    flagStore: store,
  };
}
