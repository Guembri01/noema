"use client";

import { useRouter } from "next/navigation";
import { LogOut, MonitorSmartphone } from "lucide-react";
import { revokeAllSessionsAction, revokeSessionAction } from "@/server/actions/auth-sessions";
import { useAction } from "@/lib/actions-client";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";

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
};

export function SessionsManager({
  sessions,
  locale,
}: {
  sessions: SessionRow[];
  locale: string;
}) {
  const router = useRouter();
  const { run, pending } = useAction(locale);

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
          {sessions.map((session) => (
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
          ))}
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
