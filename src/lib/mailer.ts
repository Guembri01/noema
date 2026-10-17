import nodemailer, { type Transporter } from "nodemailer";
import { prisma } from "./db";
import { decryptSecret } from "./secrets";

/**
 * SMTP mail. Configuration lives per workspace (settings → Email) with the
 * environment as a fallback, so a self-hosted instance can send invitations
 * without any per-workspace setup. Every attempt is written to EmailDelivery so
 * the settings screen can show what was sent.
 */

export type MailRuntimeConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  source: "workspace" | "env";
};

export const MAIL_NOT_CONFIGURED =
  "Email is not configured. Add SMTP details in workspace settings (Email) or set SMTP_HOST / SMTP_FROM.";

export async function resolveMailConfig(
  workspaceId?: string | null,
): Promise<MailRuntimeConfig | null> {
  if (workspaceId) {
    const stored = await prisma.emailConfig
      .findUnique({
        where: { workspaceId },
        select: {
          host: true,
          port: true,
          secure: true,
          username: true,
          passwordEncrypted: true,
          fromName: true,
          fromEmail: true,
          replyTo: true,
        },
      })
      .catch(() => null);
    if (stored?.host && stored.fromEmail) {
      return {
        host: stored.host,
        port: stored.port,
        secure: stored.secure,
        username: stored.username,
        password: decryptSecret(stored.passwordEncrypted),
        fromName: stored.fromName?.trim() || "Noema",
        fromEmail: stored.fromEmail,
        replyTo: stored.replyTo,
        source: "workspace",
      };
    }
  }

  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (host && from) {
    return {
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      username: process.env.SMTP_USER ?? null,
      password: process.env.SMTP_PASSWORD ?? null,
      fromName: process.env.SMTP_FROM_NAME ?? "Noema",
      fromEmail: from,
      replyTo: process.env.SMTP_REPLY_TO ?? null,
      source: "env",
    };
  }
  return null;
}

function transportFor(config: MailRuntimeConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username ? { user: config.username, pass: config.password ?? "" } : undefined,
    // Self-hosted smtp relays often use self-signed certificates or plain auth.
    tls: { rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== "true" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
};

/**
 * Send one message and record the outcome. Never throws: the caller receives a
 * result so invitation flows can fall back to showing the link.
 */
export async function sendMail(
  workspaceId: string,
  message: MailMessage,
): Promise<{ ok: true } | { error: string }> {
  const config = await resolveMailConfig(workspaceId);
  if (!config) {
    await recordDelivery(workspaceId, message, "skipped", MAIL_NOT_CONFIGURED);
    return { error: MAIL_NOT_CONFIGURED };
  }

  try {
    const transport = transportFor(config);
    await transport.sendMail({
      from: config.fromName ? `"${config.fromName}" <${config.fromEmail}>` : config.fromEmail,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: config.replyTo ?? undefined,
    });
    transport.close();
    await recordDelivery(workspaceId, message, "sent", null);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "SMTP send failed";
    await recordDelivery(workspaceId, message, "failed", reason.slice(0, 500));
    return { error: reason };
  }
}

async function recordDelivery(
  workspaceId: string,
  message: MailMessage,
  status: string,
  error: string | null,
) {
  await prisma.emailDelivery
    .create({
      data: {
        workspaceId,
        to: message.to,
        subject: message.subject,
        kind: message.kind,
        status,
        error,
      },
    })
    .catch(() => undefined);
}

/** Verify the SMTP connection without sending to a real recipient. */
export async function verifyMail(
  workspaceId: string,
): Promise<{ ok: true; source: string } | { error: string }> {
  const config = await resolveMailConfig(workspaceId);
  if (!config) return { error: MAIL_NOT_CONFIGURED };
  try {
    const transport = transportFor(config);
    await transport.verify();
    transport.close();
    return { ok: true, source: config.source };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "SMTP verification failed" };
  }
}

/**
 * Shared, simple HTML shell for transactional email.
 *
 * `heading` and `body` are HTML fragments: the caller escapes the
 * user-controlled names inside them and keeps the markup it wants (the
 * invitation body carries a `<strong>` around the workspace name), so they
 * are interpolated as given. Every other field is escaped here — `ctaUrl` in
 * attribute context, `ctaLabel` and `footer` in text context — so a value
 * that reaches the template unescaped can never break out of the attribute
 * or of the text it lands in.
 */
export function emailTemplate(input: {
  heading: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footer?: string;
}): { text: string; html: string } {
  const text = [
    input.heading,
    "",
    input.body,
    input.ctaUrl ? `\n${input.ctaLabel ?? "Open"}: ${input.ctaUrl}` : "",
    input.footer ? `\n${input.footer}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f7f7f5;font-family:ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#37352f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #e9e9e7;border-radius:12px">
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 12px;font-size:20px">${input.heading}</h1>
        <p style="margin:0 0 20px;line-height:1.6;color:#4a4a47">${input.body}</p>
        ${
          input.ctaUrl
            ? `<a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:#1a75d2;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:500">${escapeHtml(
                input.ctaLabel ?? "Open",
              )}</a>`
            : ""
        }
        ${
          input.footer
            ? `<p style="margin:24px 0 0;font-size:12px;color:#6b6a65">${escapeHtml(
                input.footer,
              )}</p>`
            : ""
        }
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { text, html };
}

/** Escape user-controlled strings before interpolating them into email HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
