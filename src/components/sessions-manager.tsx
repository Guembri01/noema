"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, MonitorSmartphone, ShieldAlert } from "lucide-react";
import { revokeAllSessionsAction, revokeSessionAction } from "@/server/actions/auth-sessions";
import { useAction } from "@/lib/actions-client";
import { relativeTime, useMountedNow } from "@/components/api-token-manager";
import { LocalTime } from "@/components/local-time";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { parseUserAgent } from "@/lib/user-agent";
import { remainingMs, shouldWarn } from "@/lib/session-timeout";

/** Warn once a session is within this long of its stored deadline. */
const SESSION_WARN_BEFORE_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------------- *
 * Pure domain helpers
 *
 * The device list's decisions that do not touch the DOM live here, so they can
 * be unit-tested without a browser: the parsed device/browser label, the
 * status → badge tone map and the idle-expiry view.
 * ------------------------------------------------------------------------- */

/** Lifecycle status of a listed session (mirrors the pure session engine). */
export type SessionStatus = "active" | "idle" | "expired" | "revoked";

/** The four statuses, in render order. */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  "active",
  "idle",
  "expired",
  "revoked",
];

/** Type guard for a status coming from the registry. */
export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

/** Badge tone per status: active is healthy, idle warns, expired/revoked are bad. */
export const SESSION_STATUS_TONES: Readonly<Record<SessionStatus, BadgeTone>> = {
  active: "success",
  idle: "warning",
  expired: "danger",
  revoked: "danger",
};

/** The badge tone for a session status; unknown/absent reads `neutral`. */
export function sessionStatusTone(status: string | null | undefined): BadgeTone {
  return isSessionStatus(status) ? SESSION_STATUS_TONES[status] : "neutral";
}

/** Display label per status. Plain English until the i18n catalogue grows keys. */
export const SESSION_STATUS_LABELS: Readonly<Record<SessionStatus, string>> = {
  active: "Active",
  idle: "Idle",
  expired: "Expired",
  revoked: "Signed out",
};

/**
 * The device/browser label for a row: the stored label when the registry
 * supplied one, otherwise a best-effort label parsed from the raw user-agent
 * (`"Chrome on Windows"`). Returns `null` when nothing can be described.
 */
export function sessionDeviceLabel(session: {
  device?: string | null;
  userAgent?: string | null;
}): string | null {
  const stored = typeof session.device === "string" ? session.device.trim() : "";
  if (stored) return stored;

  const ua = session.userAgent;
  if (typeof ua !== "string" || ua.trim() === "") return null;

  const info = parseUserAgent(ua);
  const browser = info.browser !== "unknown" ? info.browser : null;
  const os = info.os !== "unknown" ? info.os : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os;
}

/**
 * The status to surface for a row: an explicit registry status wins; otherwise
 * a stored deadline in the past reads as `expired`. `null` means "no badge".
 * `now` may be `null` before mount, in which case only explicit statuses show.
 */
export function sessionStatus(
  session: { status?: string | null; expiresAt?: string | null },
  now: number | null,
): SessionStatus | null {
  if (isSessionStatus(session.status)) return session.status;
  if (now !== null && session.expiresAt) {
    const ms = Date.parse(session.expiresAt);
    if (Number.isFinite(ms) && ms <= now) return "expired";
  }
  return null;
}

/**
 * Derive the idle-expiry view for one row, or `null` when the registry did not
 * expose a parseable deadline. `now` is injected so the render is deterministic.
 */
export function sessionExpiry(
  session: SessionRow,
  now: number,
): { remaining: number; warn: boolean } | null {
  if (!session.expiresAt) return null;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  const lastActivityAt = Date.parse(session.lastActiveAt);
  const state = {
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : expiresAt,
    expiresAt,
  };
  return {
    remaining: remainingMs(state, now),
    warn: shouldWarn(state, now, { warnBeforeMs: SESSION_WARN_BEFORE_MS }),
  };
}

/* ------------------------------------------------------------------------- *
 * Presentation
 * ------------------------------------------------------------------------- */

/**
 * B54 — active-session list + revoke (matrix §17 "Session management").
 *
 * The settings page (RSC) passes the rows it read from the session registry;
 * every mutation goes through the guarded server actions, which enforce
 * owner-of-session revocation server-side.
 */
export type SessionRow = {
  sid: string;
  device: string | null;
  createdAt: string;
  lastActiveAt: string;
  /** True for the session behind the caller's own cookie. */
  current: boolean;
  /**
   * ISO instant the session is scheduled to end at, when the registry exposes
   * one. Absent (or unparseable) rows render exactly as before — no expiry line.
   */
  expiresAt?: string | null;
  /** Raw user-agent, when the registry kept one (used for the device label). */
  userAgent?: string | null;
  /** Originating IP, when the registry exposes one. */
  ip?: string | null;
  /** Lifecycle status; absent rows derive it from `expiresAt` when possible. */
  status?: SessionStatus | null;
};

/** One device row: label + chips, IP, relative activity and a danger revoke. */
export function SessionListItem({
  session,
  now,
  locale,
  pending = false,
  onRevoke,
}: {
  session: SessionRow;
  now: number | null;
  locale: string;
  pending?: boolean;
  onRevoke: (sid: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const device = sessionDeviceLabel(session) ?? t(locale, "sessionUnknownDevice");
  const status = sessionStatus(session, now);
  const expiry = now === null ? null : sessionExpiry(session, now);
  const ip = typeof session.ip === "string" ? session.ip.trim() : "";

  return (
    <li
      data-testid="session-row"
      data-current={session.current ? "true" : "false"}
      data-status={status ?? undefined}
      className="flex items-center gap-3 px-4 py-3 text-sm"
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-fg" title={device}>
            {device}
          </span>
          {session.current ? (
            <Badge tone="accent" size="sm" data-testid="session-current-badge">
              {t(locale, "sessionCurrentBadge")}
            </Badge>
          ) : null}
          {status && status !== "active" ? (
            <Badge
              tone={sessionStatusTone(status)}
              size="sm"
              data-testid="session-status-badge"
            >
              {SESSION_STATUS_LABELS[status]}
            </Badge>
          ) : null}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          {ip ? (
            <span className="tabular-nums" data-testid="session-ip">
              {ip}
            </span>
          ) : null}
          <span data-testid="session-last-active">
            {t(locale, "sessionLastActive")}{" "}
            {now === null ? (
              <LocalTime value={session.lastActiveAt} />
            ) : (
              relativeTime(session.lastActiveAt, now)
            )}
          </span>
          <span>
            {t(locale, "sessionSignedInAt")}{" "}
            <LocalTime value={session.createdAt} mode="date" />
          </span>
          {expiry ? (
            <span
              data-testid="session-expiry"
              className={expiry.warn ? "text-warning" : undefined}
              suppressHydrationWarning
            >
              {t(locale, "expiresWord")}{" "}
              {formatDuration(expiry.remaining, { style: "short" })}
            </span>
          ) : null}
        </span>
      </span>

      {session.current ? null : (
        <span className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(locale, "revokeSession")}
            data-testid="session-revoke"
            disabled={pending}
            onClick={() => setConfirmOpen(true)}
            className="text-muted hover:text-danger"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </Button>
        </span>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="danger"
        title={t(locale, "revokeSession")}
        description={device}
        confirmLabel={t(locale, "revokeSession")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() => {
          setConfirmOpen(false);
          onRevoke(session.sid);
        }}
      />
    </li>
  );
}

/** The device list with its loading/empty/rows states. */
export function SessionList({
  sessions,
  now,
  locale,
  pending = false,
  loading = false,
  onRevoke,
}: {
  sessions: readonly SessionRow[];
  now: number | null;
  locale: string;
  pending?: boolean;
  loading?: boolean;
  onRevoke: (sid: string) => void;
}) {
  if (loading) {
    return (
      <Skeleton variant="table" rows={3} cols={3} data-testid="sessions-skeleton" />
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        variant="compact"
        data-testid="sessions-empty"
        icon={<MonitorSmartphone className="h-4 w-4" aria-hidden />}
        title={t(locale, "sessionsNone")}
      />
    );
  }

  return (
    <Card padding="none" variant="flat" className="overflow-hidden">
      <ul className="divide-y divide-border" data-testid="sessions-list">
        {sessions.map((session) => (
          <SessionListItem
            key={session.sid}
            session={session}
            now={now}
            locale={locale}
            pending={pending}
            onRevoke={onRevoke}
          />
        ))}
      </ul>
    </Card>
  );
}

export function SessionsManager({
  sessions,
  locale,
  now: injectedNow,
  loading = false,
}: {
  sessions: SessionRow[];
  locale: string;
  /** Injected clock (ms since epoch) for deterministic rendering/tests. */
  now?: number;
  /** Render the list skeleton instead of rows. */
  loading?: boolean;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const now = useMountedNow(injectedNow);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);

  return (
    <Section
      className="mt-10"
      data-testid="sessions-section"
      title={t(locale, "sessionsHeading")}
      description={t(locale, "sessionsIntro")}
    >
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <SessionList
        sessions={sessions}
        now={now}
        locale={locale}
        pending={pending}
        loading={loading}
        onRevoke={(sid) =>
          run(() => revokeSessionAction(sid), {
            success: t(locale, "sessionRevoked"),
            onSuccess: () => router.refresh(),
          })
        }
      />

      <div className="flex justify-end">
        <Button
          type="button"
          variant="danger"
          tone="soft"
          data-testid="revoke-all-sessions"
          disabled={pending || sessions.length === 0}
          onClick={() => setRevokeAllOpen(true)}
          leftIcon={<ShieldAlert className="h-4 w-4" aria-hidden />}
        >
          {t(locale, "sessionsRevokeAll")}
        </Button>
      </div>

      <ConfirmDialog
        open={revokeAllOpen}
        onOpenChange={setRevokeAllOpen}
        tone="danger"
        title={t(locale, "sessionsRevokeAll")}
        description="This signs every device out, including this one."
        confirmLabel={t(locale, "sessionsRevokeAll")}
        cancelLabel={t(locale, "cancel")}
        pending={pending}
        onConfirm={() => {
          setRevokeAllOpen(false);
          run(() => revokeAllSessionsAction(), {
            success: t(locale, "sessionsRevokedAll"),
            onSuccess: () => router.push("/login"),
          });
        }}
      />
    </Section>
  );
}
