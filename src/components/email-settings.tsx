"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Copy,
  Mail,
  Send,
  ServerCog,
  Trash2,
  UserPlus,
} from "lucide-react";
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
import { safeAction } from "@/lib/actions-client";
import { isValidEmail } from "@/lib/email-validation";
import { LocalTime } from "@/components/local-time";
import { membersCapabilities } from "@/lib/workspace-role-map";
import { t } from "@/lib/i18n";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type DeliveryRow = {
  id: string;
  to: string;
  subject: string;
  kind: string;
  status: string;
  error: string | null;
  createdAt: string;
};

/* -------------------------------------------------------------------------- *
 * Pure mappings — encryption ⇄ secure, delivery status → tone, validation
 * -------------------------------------------------------------------------- */

/** The transport security the SMTP form exposes (the "encryption" enum). */
export type Encryption = "implicit" | "starttls" | "none";

/** One encryption option: the stored `secure` flag and its conventional port. */
export type EncryptionOption = {
  value: Encryption;
  /** nodemailer `secure` flag (implicit TLS). */
  secure: boolean;
  /** Conventional port for the mode; used to pre-fill the port field. */
  port: number;
  /** Fallback label; `implicit` is swapped for the locale's string at render. */
  label: string;
  description: string;
};

/** The canonical encryption list. Pure — pinned by the node test. */
export const ENCRYPTION_OPTIONS: readonly EncryptionOption[] = [
  {
    value: "implicit",
    secure: true,
    port: 465,
    label: "Implicit TLS (port 465)",
    description: "TLS from the first byte; the usual choice for port 465.",
  },
  {
    value: "starttls",
    secure: false,
    port: 587,
    label: "STARTTLS (port 587)",
    description: "Upgrades a plain connection; the usual choice for port 587.",
  },
  {
    value: "none",
    secure: false,
    port: 25,
    label: "None (port 25)",
    description: "Plain SMTP with no encryption; only for trusted networks.",
  },
];

/** The stored `secure` flag for an encryption value (unknown → `false`). */
export function encryptionToSecure(value: string): boolean {
  return ENCRYPTION_OPTIONS.find((option) => option.value === value)?.secure ?? false;
}

/** The conventional port for an encryption value (unknown → 587). */
export function portForEncryption(value: string): number {
  return ENCRYPTION_OPTIONS.find((option) => option.value === value)?.port ?? 587;
}

/** Derive the encryption value from a stored config (secure + port). */
export function secureToEncryption(
  secure: boolean,
  port: number | string,
): Encryption {
  if (secure) return "implicit";
  const numeric = Number(port);
  if (Number.isFinite(numeric) && numeric === 25) return "none";
  return "starttls";
}

/** The encryption Select options for a locale. */
export function encryptionOptions(locale: string): SelectOption[] {
  return ENCRYPTION_OPTIONS.map((option) => ({
    value: option.value,
    label: option.value === "implicit" ? t(locale, "implicitTls") : option.label,
    description: option.description,
  }));
}

/**
 * Badge tone for an email delivery status. `sent` is the only success; a
 * `failed` send is danger; anything in flight reads as a warning.
 */
export function deliveryStatusTone(status: string): BadgeTone {
  switch (status.toLowerCase()) {
    case "sent":
    case "delivered":
      return "success";
    case "failed":
    case "bounced":
      return "danger";
    case "queued":
    case "pending":
    case "sending":
      return "warning";
    default:
      return "neutral";
  }
}

/** Inline copy for this panel. Kept here (not scattered) for the i18n pass. */
export const EMAIL_MESSAGES = {
  hostRequired: "An SMTP host is required.",
  portRequired: "Enter a port.",
  portRange: "The port must be a whole number between 1 and 65535.",
  fromRequired: "A sender address is required.",
  fromInvalid: "Enter a valid sender address.",
  replyToInvalid: "Enter a valid reply-to address.",
  fixFields: "Fix the highlighted fields.",
  testSentTo: "Test email sent to",
  encryptionLabel: "Encryption",
  clearTitle: "Remove SMTP settings?",
  clearBody:
    "Workspace invitations will fall back to environment variables, if any.",
} as const;

/** Field-keyed errors for the SMTP form. Empty object means valid. */
export type EmailFormErrors = {
  host?: string;
  port?: string;
  fromEmail?: string;
  replyTo?: string;
};

/** Validate the SMTP form. Pure — mirrors `saveEmailConfigAction`'s checks. */
export function validateEmailForm(input: {
  host: string;
  port: string;
  fromEmail: string;
  replyTo: string;
}): EmailFormErrors {
  const errors: EmailFormErrors = {};
  if (!input.host.trim()) errors.host = EMAIL_MESSAGES.hostRequired;

  if (!input.port.trim()) {
    errors.port = EMAIL_MESSAGES.portRequired;
  } else {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.port = EMAIL_MESSAGES.portRange;
    }
  }

  if (!input.fromEmail.trim()) errors.fromEmail = EMAIL_MESSAGES.fromRequired;
  else if (!isValidEmail(input.fromEmail)) {
    errors.fromEmail = EMAIL_MESSAGES.fromInvalid;
  }

  if (input.replyTo.trim() && !isValidEmail(input.replyTo)) {
    errors.replyTo = EMAIL_MESSAGES.replyToInvalid;
  }

  return errors;
}

/** Whether a validation result carries any problem. */
export function hasEmailFormErrors(errors: EmailFormErrors): boolean {
  return Boolean(errors.host || errors.port || errors.fromEmail || errors.replyTo);
}

/** The invite-role enum (a Select), labelled for a locale. */
export const INVITE_ROLE_VALUES = ["GUEST", "MEMBER", "ADMIN"] as const;
export type InviteRole = (typeof INVITE_ROLE_VALUES)[number];

export function inviteRoleOptions(locale: string): SelectOption[] {
  return [
    { value: "GUEST", label: t(locale, "inviteRoleGuest"), tag: "gray" },
    { value: "MEMBER", label: t(locale, "inviteRoleMember"), tag: "blue" },
    { value: "ADMIN", label: t(locale, "inviteRoleAdmin"), tag: "purple" },
  ];
}

/** The invitation roles the signed-in actor may actually grant. */
export function assignableInviteRoleOptions(locale: string, role: string): SelectOption[] {
  const assignable = membersCapabilities(role).assignable;
  return inviteRoleOptions(locale).filter((option) =>
    assignable.includes(option.value as InviteRole),
  );
}

/* -------------------------------------------------------------------------- *
 * Presentational SMTP form
 * -------------------------------------------------------------------------- */

export type EmailFormValue = {
  host: string;
  port: string;
  encryption: Encryption;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
};

export type FormFeedback = { kind: "success" | "error"; message: string };

export type EmailFormProps = {
  locale: string;
  value: EmailFormValue;
  errors?: EmailFormErrors;
  hasPassword: boolean;
  pending?: boolean;
  saveFeedback?: FormFeedback | null;
  testTo: string;
  testPending?: boolean;
  testFeedback?: FormFeedback | null;
  showClear?: boolean;
  onChange: (patch: Partial<EmailFormValue>) => void;
  onSave: () => void;
  onTest: () => void;
  onTestToChange: (value: string) => void;
  onRequestClear?: () => void;
};

/**
 * The SMTP transport form. Pure presentation: every piece of state and every
 * action lives in `EmailSettings`, so this can be statically rendered (default
 * and invalid) in a node test.
 */
export function EmailForm({
  locale,
  value,
  errors = {},
  hasPassword,
  pending = false,
  saveFeedback = null,
  testTo,
  testPending = false,
  testFeedback = null,
  showClear = false,
  onChange,
  onSave,
  onTest,
  onTestToChange,
  onRequestClear,
}: EmailFormProps) {
  const hostId = useId();
  const portId = useId();
  const encryptionId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const fromNameId = useId();
  const fromEmailId = useId();
  const replyToId = useId();

  const busy = pending || testPending;

  return (
    <form
      data-testid="email-form"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Field
          id={hostId}
          label={t(locale, "smtpHostLabel")}
          error={errors.host}
          required
        >
          <Input
            value={value.host}
            onChange={(event) => onChange({ host: event.target.value })}
            placeholder={t(locale, "smtpHostPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id={portId}
            label={t(locale, "portLabel")}
            error={errors.port}
            required
          >
            <Input
              value={value.port}
              inputMode="numeric"
              onChange={(event) => onChange({ port: event.target.value })}
              aria-label={t(locale, "smtpPortAria")}
            />
          </Field>

          <Field
            id={encryptionId}
            label={EMAIL_MESSAGES.encryptionLabel}
          >
            <Select
              options={encryptionOptions(locale)}
              value={value.encryption}
              onChange={(next) =>
                onChange({
                  encryption: next as Encryption,
                  port: String(portForEncryption(next)),
                })
              }
              locale={locale}
              allowClear={false}
              aria-label={t(locale, "tlsAria")}
            />
          </Field>
        </div>

        <Field id={usernameId} label={t(locale, "usernameLabel")}>
          <Input
            value={value.username}
            onChange={(event) => onChange({ username: event.target.value })}
            autoComplete="off"
          />
        </Field>

        <Field
          id={passwordId}
          label={t(locale, "passwordLabel")}
          hint={hasPassword ? t(locale, "savedPasswordHint") : undefined}
        >
          <Input
            type="password"
            value={value.password}
            onChange={(event) => onChange({ password: event.target.value })}
            placeholder={hasPassword ? t(locale, "savedPasswordHint") : ""}
            autoComplete="new-password"
          />
        </Field>

        <Field id={fromNameId} label={t(locale, "fromNameLabel")}>
          <Input
            value={value.fromName}
            onChange={(event) => onChange({ fromName: event.target.value })}
            autoComplete="off"
          />
        </Field>

        <Field
          id={fromEmailId}
          label={t(locale, "fromAddressLabel")}
          error={errors.fromEmail}
          required
        >
          <Input
            value={value.fromEmail}
            onChange={(event) => onChange({ fromEmail: event.target.value })}
            placeholder={t(locale, "smtpFromPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          id={replyToId}
          label={t(locale, "replyToLabel")}
          error={errors.replyTo}
        >
          <Input
            value={value.replyTo}
            onChange={(event) => onChange({ replyTo: event.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          leftIcon={<ServerCog className="h-4 w-4" />}
        >
          {t(locale, "saveSmtp")}
        </Button>

        <Field
          id="test-recipient"
          label={t(locale, "testRecipientAria")}
          className="w-full sm:w-64"
        >
          <Input
            value={testTo}
            onChange={(event) => onTestToChange(event.target.value)}
            placeholder={t(locale, "testRecipientPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Button
          type="button"
          variant="secondary"
          loading={testPending}
          leftIcon={<Send className="h-4 w-4" />}
          onClick={onTest}
        >
          {t(locale, "verifySendTest")}
        </Button>

        {showClear ? (
          <Button
            type="button"
            variant="danger"
            tone="soft"
            leftIcon={<Trash2 className="h-4 w-4" />}
            onClick={onRequestClear}
            disabled={busy}
          >
            {t(locale, "remove")}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        {saveFeedback ? (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-xs",
              saveFeedback.kind === "success" ? "text-success" : "text-danger",
            )}
          >
            {saveFeedback.message}
          </p>
        ) : null}
        {testFeedback ? (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-xs",
              testFeedback.kind === "success" ? "text-success" : "text-danger",
            )}
          >
            {testFeedback.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- *
 * Container
 * -------------------------------------------------------------------------- */

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
  currentUserRole,
}: {
  workspaceId: string;
  summary: EmailSummary;
  invites: WorkspaceInviteSummary[];
  deliveries: DeliveryRow[];
  locale: string;
  /** The signed-in user's role — the picker offers only the roles they may grant. */
  currentUserRole: string;
}) {
  const router = useRouter();
  const [savePending, startSave] = useTransition();
  const [testPending, startTest] = useTransition();
  const [invitePending, startInvite] = useTransition();
  const [clearPending, startClear] = useTransition();

  const [form, setForm] = useState<EmailFormValue>({
    host: summary.host,
    port: String(summary.port),
    encryption: secureToEncryption(summary.secure, summary.port),
    username: summary.username ?? "",
    password: "",
    fromName: summary.fromName,
    fromEmail: summary.fromEmail,
    replyTo: summary.replyTo ?? "",
  });
  const [errors, setErrors] = useState<EmailFormErrors>({});
  const [saveFeedback, setSaveFeedback] = useState<FormFeedback | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testFeedback, setTestFeedback] = useState<FormFeedback | null>(null);
  const [clearing, setClearing] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("GUEST");
  const [lastLink, setLastLink] = useState<string | null>(null);

  // The invitation picker offers only the roles this actor may actually grant.
  // The server asks the same role matrix, so an admin is not offered "Admin".
  const assignableInviteRoles = assignableInviteRoleOptions(locale, currentUserRole);

  const patchForm = (patch: Partial<EmailFormValue>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const saveSmtp = () => {
    const nextErrors = validateEmailForm({
      host: form.host,
      port: form.port,
      fromEmail: form.fromEmail,
      replyTo: form.replyTo,
    });
    setErrors(nextErrors);
    if (hasEmailFormErrors(nextErrors)) {
      setSaveFeedback({ kind: "error", message: EMAIL_MESSAGES.fixFields });
      return;
    }
    startSave(async () => {
      const outcome = await safeAction(() =>
        saveEmailConfigAction({
          workspaceId,
          host: form.host.trim(),
          port: Number(form.port) || 587,
          secure: encryptionToSecure(form.encryption),
          username: form.username,
          password: form.password || undefined,
          fromName: form.fromName,
          fromEmail: form.fromEmail,
          replyTo: form.replyTo,
        }),
      );
      if (!outcome.ok) {
        setSaveFeedback({ kind: "error", message: outcome.error });
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        setSaveFeedback({ kind: "error", message: outcome.value.error });
        toast.error(outcome.value.error);
        return;
      }
      setForm((prev) => ({ ...prev, password: "" }));
      setSaveFeedback({ kind: "success", message: t(locale, "emailSaved") });
      toast.success(t(locale, "emailSaved"));
      router.refresh();
    });
  };

  const test = () => {
    startTest(async () => {
      const outcome = await safeAction(() => testEmailAction(workspaceId, testTo));
      if (!outcome.ok) {
        setTestFeedback({ kind: "error", message: outcome.error });
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        setTestFeedback({ kind: "error", message: outcome.value.error });
        toast.error(outcome.value.error);
        return;
      }
      setTestFeedback({
        kind: "success",
        message: `${t(locale, "sentToPrefix")} ${outcome.value.sentTo ?? ""}`.trim(),
      });
      toast.success(t(locale, "smtpVerified"));
      router.refresh();
    });
  };

  const clearSmtp = () => {
    startClear(async () => {
      const outcome = await safeAction(() => clearEmailConfigAction(workspaceId));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      setClearing(false);
      toast.success(t(locale, "smtpRemoved"));
      router.refresh();
    });
  };

  const invite = () => {
    startInvite(async () => {
      const outcome = await safeAction(() =>
        sendWorkspaceInviteAction({
          workspaceId,
          email: inviteEmail,
          role: inviteRole,
        }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      setInviteEmail("");
      setLastLink(outcome.value.link);
      void navigator.clipboard?.writeText(outcome.value.link).catch(() => undefined);
      toast.success(
        outcome.value.emailed
          ? t(locale, "emailed")
          : outcome.value.warning?.includes("not configured")
            ? t(locale, "linkCopiedNotConfigured")
            : t(locale, "linkCopiedFailed"),
      );
    });
  };

  const revokeInvite = (inviteId: string) => {
    startInvite(async () => {
      const outcome = await safeAction(() => revokeWorkspaceInviteAction(inviteId));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success(t(locale, "inviteRevoked"));
      router.refresh();
    });
  };

  const statusText =
    summary.source === "workspace"
      ? `${t(locale, "smtpSourceWorkspace")} · ${summary.fromEmail}`
      : summary.source === "env"
        ? t(locale, "smtpSourceEnv")
        : t(locale, "smtpNotConfigured");

  return (
    <div className="mt-10 flex flex-col gap-10">
      <Section
        title={t(locale, "emailHeading")}
        description={
          <>
            {t(locale, "emailIntroA")} <code>SMTP_HOST</code> /{" "}
            <code>SMTP_FROM</code> {t(locale, "emailIntroB")}{" "}
            <span className="text-fg-subtle">
              {t(locale, "statusLabel")}{" "}
              <strong className="text-fg">{statusText}</strong>
            </span>
          </>
        }
      >
        <EmailForm
          locale={locale}
          value={form}
          errors={errors}
          hasPassword={summary.hasPassword}
          pending={savePending}
          saveFeedback={saveFeedback}
          testTo={testTo}
          testPending={testPending}
          testFeedback={testFeedback}
          showClear={summary.source === "workspace"}
          onChange={patchForm}
          onSave={saveSmtp}
          onTest={test}
          onTestToChange={setTestTo}
          onRequestClear={() => setClearing(true)}
        />
      </Section>

      <Section
        title={t(locale, "inviteClientTeammate")}
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field
            id="invite-email"
            label={t(locale, "inviteEmailAria")}
            className="w-full sm:w-64"
          >
            <Input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder={t(locale, "inviteEmailPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field id="invite-role" label={t(locale, "inviteRoleAria")}>
            <Select
              options={assignableInviteRoles}
              value={inviteRole}
              onChange={(next) => setInviteRole(next as InviteRole)}
              locale={locale}
              allowClear={false}
              aria-label={t(locale, "inviteRoleAria")}
            />
          </Field>

          <Button
            variant="primary"
            loading={invitePending}
            disabled={!inviteEmail.trim()}
            leftIcon={<Mail className="h-4 w-4" />}
            onClick={invite}
          >
            {t(locale, "sendInvitation")}
          </Button>
        </div>

        {lastLink ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Copy className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate" title={lastLink}>
              {lastLink}
            </span>
          </p>
        ) : null}

        {invites.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {invites.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 px-3 py-2 text-xs text-muted"
              >
                <span className="flex-1 truncate">
                  {row.email} · {row.role.toLowerCase()} · {t(locale, "expiresWord")}{" "}
                  <LocalTime value={row.expiresAt} mode="date" />
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  tone="soft"
                  className="shrink-0 text-muted hover:text-danger"
                  aria-label={`${t(locale, "revokeInviteAria")} ${row.email}`}
                  onClick={() => revokeInvite(row.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            variant="compact"
            icon={<UserPlus className="h-4 w-4" />}
            title={t(locale, "noMembersYet")}
            description={t(locale, "inviteClientTeammate")}
          />
        )}
      </Section>

      <Section
        title={t(locale, "recentEmail")}
        level={2}
      >
        {deliveries.length === 0 ? (
          savePending || testPending ? (
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} variant="row" />
              ))}
            </div>
          ) : (
            <EmptyState
              variant="compact"
              icon={<Mail className="h-4 w-4" />}
              title={t(locale, "noDataYet")}
              description={t(locale, "recentEmail")}
              primaryAction={
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Send className="h-4 w-4" />}
                  onClick={test}
                >
                  {t(locale, "verifySendTest")}
                </Button>
              }
            />
          )
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {deliveries.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-3 px-3 py-2 text-xs text-muted"
              >
                <Badge
                  size="sm"
                  tone={deliveryStatusTone(row.status)}
                  title={row.error ?? undefined}
                >
                  {row.status}
                </Badge>
                <span className="flex-1 truncate" title={`${row.to} · ${row.subject}`}>
                  {row.to} · {row.subject}
                </span>
                {row.error ? (
                  <span className="hidden max-w-[40%] truncate opacity-70 sm:inline" title={row.error}>
                    — {row.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        tone="danger"
        title={EMAIL_MESSAGES.clearTitle}
        description={EMAIL_MESSAGES.clearBody}
        confirmLabel={t(locale, "remove")}
        cancelLabel={t(locale, "cancel")}
        pending={clearPending}
        onConfirm={clearSmtp}
      />
    </div>
  );
}
