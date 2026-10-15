"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, MonitorSmartphone } from "lucide-react";
import { revokeAllSessionsAction, revokeSessionAction } from "@/server/actions/auth-sessions";
import { useAction } from "@/lib/actions-client";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";
import { formatDuration } from "@/lib/duration";
import { remainingMs, shouldWarn } from "@/lib/session-timeout";

/** Warn once a session is within this long of its stored deadline. */
const SESSION_WARN_BEFORE_MS = 24 * 60 * 60 * 1000;

/**
 * Derive the idle-expiry view for one row, or `null` when the registry did not
 * expose a parseable deadline. `now` is injected so the render is deterministic.
 */
function sessionExpiry(
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
};

export function SessionsManager({
  sessions,
  locale,
  now: injectedNow,
}: {
  sessions: SessionRow[];
  locale: string;
  /** Injected clock (ms since epoch) for deterministic rendering/tests. */
  now?: number;
}) {
  const router = useRouter();
  const { run, pending } = useAction(locale);
  // Rendered only after mount so the server and first client render agree; a
  // caller can instead pass `now` to pin the clock.
  const [mountedNow, setMountedNow] = useState<number | null>(null);
  useEffect(() => {
    setMountedNow(Date.now());
  }, []);
  const now = injectedNow ?? mountedNow;

  return (
    <section className="mt-10" data-testid="sessions-section">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <MonitorSmartphone className="h-4 w-4" />
        {t(locale, "sessionsHeading")}
      </h2>
      <p className="mb-3 text-sm text-muted">{t(locale, "sessionsIntro")}</p>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted" data-testid="sessions-empty">
          {t(locale, "sessionsNone")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="sessions-list">
          {sessions.map((session) => {
            const expiry = now === null ? null : sessionExpiry(session, now);
            return (
            <li
              key={session.sid}
              data-testid="session-row"
              data-current={session.current ? "true" : "false"}
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {session.device ?? t(locale, "sessionUnknownDevice")}
                </span>
                <span className="block text-xs text-muted">
                  {t(locale, "sessionLastActive")} <LocalTime value={session.lastActiveAt} />
                  {" · "}
                  {t(locale, "sessionSignedInAt")} <LocalTime value={session.createdAt} mode="date" />
                  {expiry && (
                    <>
                      {" · "}
                      <span
                        data-testid="session-expiry"
                        className={expiry.warn ? "text-amber-600" : undefined}
                        suppressHydrationWarning
                      >
                        {t(locale, "expiresWord")}{" "}
                        {formatDuration(expiry.remaining, { style: "short" })}
                      </span>
                    </>
                  )}
                </span>
              </span>
              {session.current ? (
                <span
                  className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted"
                  data-testid="session-current-badge"
                >
                  {t(locale, "sessionCurrentBadge")}
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={t(locale, "revokeSession")}
                  data-testid="session-revoke"
                  disabled={pending}
                  onClick={() =>
                    run(() => revokeSessionAction(session.sid), {
                      success: t(locale, "sessionRevoked"),
                      onSuccess: () => router.refresh(),
                    })
                  }
                  className="shrink-0 text-muted hover:text-red-500"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              )}
            </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4">
        <button
          type="button"
          data-testid="revoke-all-sessions"
          disabled={pending || sessions.length === 0}
          onClick={() =>
            run(() => revokeAllSessionsAction(), {
              success: t(locale, "sessionsRevokedAll"),
              onSuccess: () => router.push("/login"),
            })
          }
          className="h-9 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          {t(locale, "sessionsRevokeAll")}
        </button>
      </div>
    </section>
  );
}
