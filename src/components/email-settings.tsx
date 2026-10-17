"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Mail, Send, ServerCog, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  clearEmailConfigAction,
  revokeWorkspaceInviteAction,
  saveEmailConfigAction,
  sendWorkspaceInviteAction,
  testEmailAction,
  type EmailSummary,
  type WorkspaceInviteSummary,
} from "@/server/actions/email";
import {safeAction } from "@/lib/actions-client";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";


export type DeliveryRow = {
  id: string;
  to: string;
  subject: string;
  kind: string;
  status: string;
  error: string | null;
  createdAt: string;
};

/**
 * Workspace email: SMTP transport, client/team invitations by email, and a
 * delivery log so admins can see exactly what went out.
 */
export function EmailSettings({
  workspaceId,
  summary,
  invites,
  deliveries,
  locale,
}: {
  workspaceId: string;
  summary: EmailSummary;
  invites: WorkspaceInviteSummary[];
  deliveries: DeliveryRow[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [host, setHost] = useState(summary.host);
  const [port, setPort] = useState(String(summary.port));
  const [secure, setSecure] = useState(summary.secure);
  const [username, setUsername] = useState(summary.username ?? "");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(summary.fromName);
  const [fromEmail, setFromEmail] = useState(summary.fromEmail);
  const [replyTo, setReplyTo] = useState(summary.replyTo ?? "");
  const [testTo, setTestTo] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"GUEST" | "MEMBER" | "ADMIN">("GUEST");
  const [lastLink, setLastLink] = useState<string | null>(null);

  const run = (label: string, task: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      if (value.ok) toast.success(label);
      else toast.error(value.message ?? t(locale, "somethingWentWrong"));
      router.refresh();
    });

  const saveSmtp = () =>
    run(t(locale, "emailSaved"), async () => {
      const result = await saveEmailConfigAction({
        workspaceId,
        host,
        port: Number(port) || 587,
        secure,
        username,
        password: password || undefined,
        fromName,
        fromEmail,
        replyTo,
      });
      if ("error" in result) return { ok: false, message: result.error };
      setPassword("");
      return { ok: true };
    });

  const test = () =>
    run(t(locale, "smtpVerified"), async () => {
      const result = await testEmailAction(workspaceId, testTo);
      if ("error" in result) return { ok: false, message: result.error };
      return { ok: true, message: `${t(locale, "sentToPrefix")} ${result.sentTo}` };
    });

  const clearSmtp = () =>
    run(t(locale, "smtpRemoved"), async () => {
      const result = await clearEmailConfigAction(workspaceId);
      if ("error" in result) return { ok: false, message: result.error };
      return { ok: true };
    });

  const invite = () =>
    run(t(locale, "inviteCreated"), async () => {
      const result = await sendWorkspaceInviteAction({
        workspaceId,
        email: inviteEmail,
        role: inviteRole,
      });
      if ("error" in result) return { ok: false, message: result.error };
      setInviteEmail("");
      setLastLink(result.link);
      void navigator.clipboard?.writeText(result.link).catch(() => undefined);
      return {
        ok: true,
        message: result.emailed
          ? t(locale, "emailed")
          : result.warning?.includes("not configured")
            ? t(locale, "linkCopiedNotConfigured")
            : t(locale, "linkCopiedFailed"),
      };
    });

  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <ServerCog className="h-4 w-4" /> {t(locale, "emailHeading")}
      </h2>
      <p className="mb-4 text-sm text-muted">
        {t(locale, "emailIntroA")}{" "}
        <code>SMTP_HOST</code> / <code>SMTP_FROM</code> {t(locale, "emailIntroB")}
      </p>
      <p className="mb-4 text-xs text-muted">
        {t(locale, "statusLabel")}{" "}
        <strong className="text-fg">
          {summary.source === "workspace"
            ? `${t(locale, "smtpSourceWorkspace")} · ${summary.fromEmail}`
            : summary.source === "env"
              ? t(locale, "smtpSourceEnv")
              : t(locale, "smtpNotConfigured")}
        </strong>
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "smtpHostLabel")}
          <input
            value={host}
            aria-label={t(locale, "smtpHostLabel")}
            placeholder="smtp.example.com"
            onChange={(event) => setHost(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "portLabel")}
          <input
            value={port}
            aria-label={t(locale, "smtpPortAria")}
            inputMode="numeric"
            onChange={(event) => setPort(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "usernameLabel")}
          <input
            value={username}
            aria-label={t(locale, "smtpUsernameAria")}
            onChange={(event) => setUsername(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "passwordLabel")}
          <input
            type="password"
            value={password}
            aria-label={t(locale, "smtpPasswordAria")}
            placeholder={summary.hasPassword ? t(locale, "savedPasswordHint") : ""}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "fromNameLabel")}
          <input
            value={fromName}
            aria-label={t(locale, "senderNameAria")}
            onChange={(event) => setFromName(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "fromAddressLabel")}
          <input
            value={fromEmail}
            aria-label={t(locale, "senderAddressAria")}
            placeholder="noema@example.com"
            onChange={(event) => setFromEmail(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "replyToLabel")}
          <input
            value={replyTo}
            aria-label={t(locale, "replyToAria")}
            onChange={(event) => setReplyTo(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="mt-5 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={secure}
            aria-label={t(locale, "tlsAria")}
            onChange={(event) => setSecure(event.target.checked)}
            className="accent-[var(--accent)]"
          />
          {t(locale, "implicitTls")}
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={saveSmtp}
          className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {t(locale, "saveSmtp")}
        </button>
        <input
          value={testTo}
          aria-label={t(locale, "testRecipientAria")}
          placeholder={t(locale, "testRecipientPlaceholder")}
          onChange={(event) => setTestTo(event.target.value)}
          className="h-9 w-56 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={pending}
          onClick={test}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          <Send className="h-4 w-4" /> {t(locale, "verifySendTest")}
        </button>
        {summary.source === "workspace" && (
          <button
            type="button"
            disabled={pending}
            onClick={clearSmtp}
            className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm text-muted hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> {t(locale, "remove")}
          </button>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-border p-3">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium">
          <UserPlus className="h-4 w-4" /> {t(locale, "inviteClientTeammate")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={inviteEmail}
            aria-label={t(locale, "inviteEmailAria")}
            placeholder="client@example.com"
            onChange={(event) => setInviteEmail(event.target.value)}
            className="h-9 w-64 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <select
            value={inviteRole}
            aria-label={t(locale, "inviteRoleAria")}
            onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
            className="h-9 rounded border border-border bg-bg px-2 text-sm outline-none"
          >
            <option value="GUEST">{t(locale, "inviteRoleGuest")}</option>
            <option value="MEMBER">{t(locale, "inviteRoleMember")}</option>
            <option value="ADMIN">{t(locale, "inviteRoleAdmin")}</option>
          </select>
          <button
            type="button"
            disabled={pending || !inviteEmail.trim()}
            onClick={invite}
            className="flex h-9 items-center gap-1 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
          >
            <Mail className="h-4 w-4" /> {t(locale, "sendInvitation")}
          </button>
        </div>

        {lastLink && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            <Copy className="h-3 w-3" />
            <span className="truncate">{lastLink}</span>
          </p>
        )}

        {invites.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border pt-2">
            {invites.map((row) => (
              <li key={row.id} className="flex items-center gap-2 text-xs text-muted">
                <span className="flex-1 truncate">
                  {row.email} · {row.role.toLowerCase()} · {t(locale, "expiresWord")}{" "}
                  {<LocalTime value={row.expiresAt} mode="date" />}
                </span>
                <button
                  type="button"
                  aria-label={`${t(locale, "revokeInviteAria")} ${row.email}`}
                  onClick={() =>
                    run(t(locale, "inviteRevoked"), async () => {
                      const result = await revokeWorkspaceInviteAction(row.id);
                      return "error" in result ? { ok: false, message: result.error } : { ok: true };
                    })
                  }
                  className="shrink-0 hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {deliveries.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            {t(locale, "recentEmail")}
          </p>
          <ul className="space-y-1 text-xs text-muted">
            {deliveries.map((row) => (
              <li key={row.id} className="flex items-center gap-2">
                <span
                  className={
                    row.status === "sent"
                      ? "text-success"
                      : row.status === "failed"
                        ? "text-danger"
                        : ""
                  }
                >
                  {row.status}
                </span>
                <span className="truncate">
                  {row.to} · {row.subject}
                </span>
                {row.error && <span className="truncate opacity-70">— {row.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
