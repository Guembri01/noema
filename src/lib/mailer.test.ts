import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B88 — unit tests for `src/lib/mailer.ts` (mailer + email template rendering).
 *
 * This is a test-only change: the implementation predates the tests, so red-first
 * is proven by mutation (sabotaging the pinned behavior, capturing the failing
 * tail, reverting) — the red tails are recorded in the PR.
 *
 * Two hard properties are pinned beyond happy-path rendering:
 *  - FAIL-SOFT: SMTP missing or broken never throws at the caller; the caller
 *    gets the uniform MAIL_NOT_CONFIGURED text and a "skipped"/"failed"
 *    EmailDelivery row instead.
 *  - SECRET CANARIES: AUTH_SECRET, the SMTP password and stored `v1:` envelopes
 *    must never appear in a rendered message, an outbound transport payload or
 *    a recorded delivery. `nodemailer` is fully mocked — nothing here can open
 *    a socket, and Prisma is mocked so nothing touches a real database.
 */

const h = vi.hoisted(() => {
  const transport = {
    sendMail: vi.fn(),
    verify: vi.fn(),
    close: vi.fn(),
  };
  return {
    transport,
    createTransport: vi.fn(() => transport),
    prisma: {
      emailConfigFindUnique: vi.fn(),
      emailDeliveryCreate: vi.fn(),
    },
  };
});

vi.mock("nodemailer", () => ({ default: { createTransport: h.createTransport } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    emailConfig: { findUnique: h.prisma.emailConfigFindUnique },
    emailDelivery: { create: h.prisma.emailDeliveryCreate },
  },
}));

import {
  MAIL_NOT_CONFIGURED,
  emailTemplate,
  escapeHtml,
  resolveMailConfig,
  sendMail,
  verifyMail,
} from "@/lib/mailer";
import { encryptSecret } from "@/lib/secrets";

// --- env hygiene: these keys are mutated per test, restored afterwards ------
const ENV_KEYS = [
  "AUTH_SECRET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_FROM_NAME",
  "SMTP_REPLY_TO",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

const AUTH_SECRET_CANARY = "canary-auth-secret-B88-never-render-an-email";
const SMTP_PASSWORD_CANARY = "canary-smtp-password-B88-never-render-an-email";

function clearSmtpEnv() {
  for (const key of ENV_KEYS) {
    if (key === "AUTH_SECRET") continue;
    delete process.env[key];
  }
}

/** Configured-via-env SMTP. */
function configureEnvSmtp() {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_PORT = "2525";
  process.env.SMTP_SECURE = "true";
  process.env.SMTP_USER = "env-user";
  process.env.SMTP_PASSWORD = SMTP_PASSWORD_CANARY;
  process.env.SMTP_FROM = "noema@example.test";
  process.env.SMTP_FROM_NAME = "Noema Env";
  process.env.SMTP_REPLY_TO = "support@example.test";
}

/** Assert a blob (rendered email / payload / recorded delivery) carries no secrets. */
function expectNoSecrets(blob: string) {
  expect(blob).not.toContain(AUTH_SECRET_CANARY);
  expect(blob).not.toContain(SMTP_PASSWORD_CANARY);
  expect(blob).not.toMatch(/v1:[A-Za-z0-9+/=]+:/); // encryptSecret() envelope
  expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/); // JWT-shaped token
}

const MSG = {
  to: "new@example.test",
  subject: "Bilel invited you to Acme",
  text: "You're invited to Acme\n\nAccept invitation: https://app.example.test/invite/abc",
  html: "<!doctype html><html><body>You're invited to Acme</body></html>",
  kind: "workspace-invite",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.transport.sendMail.mockResolvedValue({ messageId: "m1" });
  h.transport.verify.mockResolvedValue(true);
  h.prisma.emailConfigFindUnique.mockResolvedValue(null);
  h.prisma.emailDeliveryCreate.mockResolvedValue({ id: "del-1" });
  clearSmtpEnv();
  process.env.AUTH_SECRET = AUTH_SECRET_CANARY;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

// ---------------------------------------------------------------------------
// emailTemplate — subject/body rendering
// ---------------------------------------------------------------------------

describe("emailTemplate — renders heading, body, CTA and footer", () => {
  it("puts every provided value into both the text and the html part", () => {
    const input = {
      heading: "You're invited to Acme",
      body: "<strong>Bilel</strong> invited you to collaborate in <strong>Acme</strong>.",
      ctaLabel: "Accept invitation",
      ctaUrl: "https://app.example.test/invite/abc",
      footer: "If you weren't expecting this, you can ignore the email.",
    };
    const { text, html } = emailTemplate(input);

    // text: heading → blank → body → CTA → footer
    expect(text).toContain("You're invited to Acme");
    expect(text).toContain(input.body);
    expect(text).toContain("Accept invitation: https://app.example.test/invite/abc");
    expect(text).toContain(input.footer);
    expect(text.indexOf(input.heading)).toBeLessThan(text.indexOf(input.body));
    expect(text.indexOf(input.body)).toBeLessThan(text.indexOf("Accept invitation:"));
    expect(text.indexOf("Accept invitation:")).toBeLessThan(text.indexOf(input.footer));

    // html: shell + values in the documented elements
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<h1");
    expect(html).toContain(input.heading);
    expect(html).toContain(input.body);
    expect(html).toContain('href="https://app.example.test/invite/abc"');
    expect(html).toContain(">Accept invitation</a>");
    // the footer is escaped by the template (the apostrophe becomes an entity)
    expect(html).toContain(escapeHtml(input.footer));
    // the CTA url is the only outbound link in the shell
    expect(html.match(/<a href=/g)).toHaveLength(1);
  });

  it("defaults the CTA label to 'Open' when ctaUrl is given without one", () => {
    const { text, html } = emailTemplate({
      heading: "Head",
      body: "Body",
      ctaUrl: "https://app.example.test/",
    });
    expect(text).toContain("Open: https://app.example.test/");
    expect(html).toContain(">Open</a>");
  });

  it("omits the CTA and footer blocks entirely when they are not provided", () => {
    const { text, html } = emailTemplate({ heading: "Head", body: "Body" });
    // the "" separator is filtered out, so no stray blank line or CTA/footer
    // residue is left behind
    expect(text).toBe("Head\nBody");
    expect(html).not.toContain("<a href=");
    expect(html).not.toContain("font-size:12px"); // footer styling
    expect(text).not.toContain("Open:");
  });

  it("keeps empty-ish optional parts out of the text join", () => {
    const { text } = emailTemplate({ heading: "Head", body: "Body", footer: "" });
    expect(text).toBe("Head\nBody");
  });
});

// ---------------------------------------------------------------------------
// emailTemplate — the values it interpolates are escaped
// ---------------------------------------------------------------------------

describe("emailTemplate — escapes the CTA url, the CTA label and the footer", () => {
  it("escapes the CTA url in attribute context (a quote cannot break out)", () => {
    const { html } = emailTemplate({
      heading: "Head",
      body: "Body",
      ctaLabel: "Accept invitation",
      ctaUrl: 'https://app.example.test/invite/tok"><img src=x onerror=alert(1)>',
    });

    // the whole payload stays inside the href attribute …
    expect(html).toContain(
      'href="https://app.example.test/invite/tok&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"',
    );
    // … and no injected tag reaches the document
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=alert(1)>");
  });

  it("escapes the CTA label and the footer in text context", () => {
    const { html } = emailTemplate({
      heading: "Head",
      body: "Body",
      ctaLabel: "Open <b>now</b>",
      ctaUrl: "https://app.example.test/",
      footer: "ignore it <script>alert(1)</script>",
    });

    expect(html).toContain("Open &lt;b&gt;now&lt;/b&gt;");
    expect(html).toContain("ignore it &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b>now</b>");
    expect(html).not.toContain("<script>");
  });

  it("leaves an ordinary CTA url untouched (the legitimate link still works)", () => {
    const { html } = emailTemplate({
      heading: "Head",
      body: "Body",
      ctaLabel: "Accept invitation",
      ctaUrl: "https://app.example.test/invite/abc",
    });

    expect(html).toContain('href="https://app.example.test/invite/abc"');
    expect(html).toContain(">Accept invitation</a>");
  });
});

describe("escapeHtml — user strings interpolated into email HTML", () => {
  it("escapes &, <, >, \" and ' in the documented order", () => {
    expect(escapeHtml('&<>"\'')).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("neutralises injected markup so no raw angle bracket survives", () => {
    const out = escapeHtml(`<img src=x onerror="alert('pwn')">`);
    expect(out).not.toContain("<");
    expect(out).toContain("&lt;img src=x onerror=");
    expect(out).toContain("&#39;pwn&#39;");
  });

  it("leaves ordinary text untouched (idempotent on already-escaped text)", () => {
    expect(escapeHtml("Bilel invited you to Acme")).toBe("Bilel invited you to Acme");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

// ---------------------------------------------------------------------------
// resolveMailConfig
// ---------------------------------------------------------------------------

describe("resolveMailConfig", () => {
  it("prefers the stored workspace row and decrypts its password", async () => {
    configureEnvSmtp(); // env must LOSE against a stored row
    h.prisma.emailConfigFindUnique.mockResolvedValue({
      host: "ws-host.example",
      port: 2525,
      secure: true,
      username: "ws-user",
      passwordEncrypted: encryptSecret("stored-pass-B88"),
      fromName: "",
      fromEmail: "ws@example.test",
      replyTo: "ws-reply@example.test",
    });

    const config = await resolveMailConfig("ws-1");
    expect(config).toMatchObject({
      host: "ws-host.example",
      port: 2525,
      secure: true,
      username: "ws-user",
      password: "stored-pass-B88",
      fromName: "Noema", // blank fromName falls back to the product name
      fromEmail: "ws@example.test",
      replyTo: "ws-reply@example.test",
      source: "workspace",
    });
    expect(config?.password).not.toBe(SMTP_PASSWORD_CANARY);
    expect(h.prisma.emailConfigFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } }),
    );
  });

  it("falls back to env vars with source 'env' and sane defaults", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noema@example.test";

    const config = await resolveMailConfig("ws-1");
    expect(config).toMatchObject({
      host: "smtp.example.test",
      port: 587, // SMTP_PORT unset → nodemailer default
      secure: false, // SMTP_SECURE unset
      username: null,
      password: null,
      fromName: "Noema",
      fromEmail: "noema@example.test",
      replyTo: null,
      source: "env",
    });
  });

  it("reads every env knob when provided", async () => {
    configureEnvSmtp();
    const config = await resolveMailConfig(null);
    expect(config).toMatchObject({
      source: "env",
      host: "smtp.example.test",
      port: 2525,
      secure: true,
      username: "env-user",
      password: SMTP_PASSWORD_CANARY,
      fromName: "Noema Env",
      fromEmail: "noema@example.test",
      replyTo: "support@example.test",
    });
  });

  it("returns null when neither a stored row nor a usable env config exists", async () => {
    expect(await resolveMailConfig("ws-1")).toBeNull();
    // host without a sender is still "not configured"
    process.env.SMTP_HOST = "smtp.example.test";
    expect(await resolveMailConfig("ws-1")).toBeNull();
  });

  it("swallows a failing config lookup and still resolves from env (no throw)", async () => {
    configureEnvSmtp();
    h.prisma.emailConfigFindUnique.mockRejectedValueOnce(new Error("db down"));
    const config = await resolveMailConfig("ws-1");
    expect(config).toMatchObject({ source: "env", host: "smtp.example.test" });
  });

  it("ignores a stored row that has no sender address", async () => {
    configureEnvSmtp();
    h.prisma.emailConfigFindUnique.mockResolvedValue({
      host: "ws-host.example",
      port: 2525,
      secure: false,
      username: null,
      passwordEncrypted: null,
      fromName: null,
      fromEmail: "", // incomplete → env fallback
      replyTo: null,
    });
    const config = await resolveMailConfig("ws-1");
    expect(config).toMatchObject({ source: "env", host: "smtp.example.test" });
  });
});

// ---------------------------------------------------------------------------
// sendMail
// ---------------------------------------------------------------------------

describe("sendMail — fail-soft when SMTP is unconfigured", () => {
  it("returns the uniform MAIL_NOT_CONFIGURED error without touching the transport", async () => {
    const result = await sendMail("ws-1", MSG);
    expectNoSecrets(JSON.stringify(result)); // canary: no secret rides the error
    expect(result).toEqual({ error: MAIL_NOT_CONFIGURED });
    expect(h.createTransport).not.toHaveBeenCalled(); // no real send is possible
  });

  it("records the attempt as 'skipped' with the same uniform text", async () => {
    await sendMail("ws-1", MSG);
    expect(h.prisma.emailDeliveryCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        to: MSG.to,
        subject: MSG.subject,
        kind: MSG.kind,
        status: "skipped",
        error: MAIL_NOT_CONFIGURED,
      },
    });
    const recorded = h.prisma.emailDeliveryCreate.mock.calls[0][0];
    expectNoSecrets(JSON.stringify(recorded));
  });

  it("keeps secrets out of both the error and the recorded row (canary)", async () => {
    process.env.SMTP_PASSWORD = SMTP_PASSWORD_CANARY; // configured-looking env, but no host/from
    const result = await sendMail("ws-1", MSG);
    // canary first: a leak must be reported BY THE CANARY, not by the
    // exact-text assertion below
    expectNoSecrets(JSON.stringify(result));
    expectNoSecrets(JSON.stringify(h.prisma.emailDeliveryCreate.mock.calls[0][0]));
    expect(result).toEqual({ error: MAIL_NOT_CONFIGURED });
  });
});

describe("sendMail — configured transport", () => {
  it("sends with the configured from/replyTo, closes the transport and records 'sent'", async () => {
    configureEnvSmtp();
    const result = await sendMail("ws-1", MSG);

    expect(result).toEqual({ ok: true });
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.transport.sendMail).toHaveBeenCalledWith({
      from: '"Noema Env" <noema@example.test>',
      to: MSG.to,
      subject: MSG.subject,
      text: MSG.text,
      html: MSG.html,
      replyTo: "support@example.test",
    });
    expect(h.transport.close).toHaveBeenCalledTimes(1);
    expect(h.prisma.emailDeliveryCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        to: MSG.to,
        subject: MSG.subject,
        kind: MSG.kind,
        status: "sent",
        error: null,
      },
    });
  });

  it("leaves replyTo off when the config has none", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noema@example.test";
    await sendMail("ws-1", MSG);
    expect(h.transport.sendMail.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("keeps the decrypted SMTP password out of the outbound payload (canary + key pin)", async () => {
    h.prisma.emailConfigFindUnique.mockResolvedValue({
      host: "ws-host.example",
      port: 465,
      secure: true,
      username: "ws-user",
      passwordEncrypted: encryptSecret("stored-pass-B88"),
      fromName: "Noema",
      fromEmail: "ws@example.test",
      replyTo: null,
    });

    const result = await sendMail("ws-1", MSG);
    expect(result).toEqual({ ok: true });

    const payload = h.transport.sendMail.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      "from",
      "html",
      "replyTo",
      "subject",
      "text",
      "to",
    ]);
    expectNoSecrets(JSON.stringify(payload));
    expectNoSecrets(JSON.stringify(h.prisma.emailDeliveryCreate.mock.calls[0][0]));
  });

  it("returns the transport failure instead of throwing and records 'failed'", async () => {
    configureEnvSmtp();
    h.transport.sendMail.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await sendMail("ws-1", MSG);
    expect(result).toEqual({ error: "Connection refused" });
    expect(h.prisma.emailDeliveryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: "Connection refused" }),
      }),
    );
    expectNoSecrets(JSON.stringify(result));
  });

  it("truncates the recorded failure reason to 500 chars but never throws", async () => {
    configureEnvSmtp();
    h.transport.sendMail.mockRejectedValueOnce(new Error("x".repeat(600)));

    const result = await sendMail("ws-1", MSG);
    expect(result).toEqual({ error: "x".repeat(600) }); // caller sees the full reason
    const recorded = h.prisma.emailDeliveryCreate.mock.calls[0][0];
    expect(recorded.data.error).toHaveLength(500);
  });

  it("maps a non-Error rejection to the generic reason", async () => {
    configureEnvSmtp();
    h.transport.sendMail.mockRejectedValueOnce("boom");
    await expect(sendMail("ws-1", MSG)).resolves.toEqual({ error: "SMTP send failed" });
  });

  it("swallows a failing EmailDelivery write (delivery bookkeeping is best-effort)", async () => {
    configureEnvSmtp();
    h.prisma.emailDeliveryCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(sendMail("ws-1", MSG)).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// verifyMail
// ---------------------------------------------------------------------------

describe("verifyMail", () => {
  it("fails soft with the uniform text and no transport when unconfigured", async () => {
    await expect(verifyMail("ws-1")).resolves.toEqual({ error: MAIL_NOT_CONFIGURED });
    expect(h.createTransport).not.toHaveBeenCalled();
    expectNoSecrets(MAIL_NOT_CONFIGURED);
  });

  it("verifies the connection and reports the config source", async () => {
    configureEnvSmtp();
    await expect(verifyMail("ws-1")).resolves.toEqual({ ok: true, source: "env" });
    expect(h.transport.verify).toHaveBeenCalledTimes(1);
    expect(h.transport.close).toHaveBeenCalledTimes(1);
  });

  it("reports 'workspace' as the source for a stored row", async () => {
    h.prisma.emailConfigFindUnique.mockResolvedValue({
      host: "ws-host.example",
      port: 2525,
      secure: false,
      username: null,
      passwordEncrypted: null,
      fromName: "Noema",
      fromEmail: "ws@example.test",
      replyTo: null,
    });
    await expect(verifyMail("ws-1")).resolves.toEqual({ ok: true, source: "workspace" });
  });

  it("returns the handshake failure instead of throwing", async () => {
    configureEnvSmtp();
    h.transport.verify.mockRejectedValueOnce(new Error("535 auth failed"));
    await expect(verifyMail("ws-1")).resolves.toEqual({ error: "535 auth failed" });
  });
});

// ---------------------------------------------------------------------------
// locale / determinism
// ---------------------------------------------------------------------------

describe("locale", () => {
  it("takes no locale input: identical inputs render byte-identical output", () => {
    // The mailer has no locale parameter and does not read i18n.ts (read-only in
    // B65); transactional copy is an English literal while UI strings around it
    // are localized. Pinning determinism also proves no hidden global state.
    const input = {
      heading: "You're invited to Acme",
      body: "Bilel invited you to collaborate in <strong>Acme</strong>.",
      ctaLabel: "Accept invitation",
      ctaUrl: "https://app.example.test/invite/abc",
      footer: "If you weren't expecting this, you can ignore the email.",
    };
    const first = emailTemplate(input);
    const second = emailTemplate(input);
    expect(second.text).toBe(first.text);
    expect(second.html).toBe(first.html);
    expect(first.text).not.toMatch(/invité|eingeladen|invitado/); // stays English
  });
});
