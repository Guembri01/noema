import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B88 — email template rendering through the real server actions.
 *
 * The templates live inside `sendWorkspaceInviteAction` /
 * `inviteTeamspaceMemberAction` / `testEmailAction`, so the tests exercise the
 * REAL authorization + permission chain (authorizeAdmin → getWorkspaceAccess →
 * canManageMembers) and the REAL mailer; only the transport edges (nodemailer,
 * Prisma, auth session, next/cache) are mocked. Nothing here opens a socket or
 * a database connection.
 *
 * Pinned properties:
 *  - expected values land in subject + text + html (invite wording, TTL, CTA);
 *  - user-controlled names are escaped in the HTML part (raw subject is fine);
 *  - SECRET CANARIES: AUTH_SECRET, the SMTP password, `v1:` envelopes, JWTs and
 *    the stored invite-token HASH never appear in a rendered message;
 *    the raw invite link does (that is the point of the email);
 *  - SMTP-unconfigured behavior FAILS SOFT: the caller still gets the link,
 *    `emailed: false` and the uniform MAIL_NOT_CONFIGURED warning — never a throw;
 *  - non-managers get a UNIFORM denial regardless of SMTP state (no oracle).
 *
 * Off-limits: email-settings.tsx (converted) and src/lib/i18n.ts (read-only).
 */

const h = vi.hoisted(() => {
  const transport = { sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() };
  return {
    transport,
    createTransport: vi.fn(() => transport),
    requireUser: vi.fn(),
    prisma: {
      workspaceMemberFindUnique: vi.fn(),
      workspaceFindUnique: vi.fn(),
      userFindUnique: vi.fn(),
      projectFindUnique: vi.fn(),
      inviteDeleteMany: vi.fn(),
      inviteCreate: vi.fn(),
      teamspaceFindUnique: vi.fn(),
      teamspaceInviteUpsert: vi.fn(),
      teamspaceMemberUpsert: vi.fn(),
      emailConfigFindUnique: vi.fn(),
      emailDeliveryCreate: vi.fn(),
    },
  };
});

vi.mock("nodemailer", () => ({ default: { createTransport: h.createTransport } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: h.prisma.workspaceMemberFindUnique },
    workspace: { findUnique: h.prisma.workspaceFindUnique },
    user: { findUnique: h.prisma.userFindUnique },
    project: { findUnique: h.prisma.projectFindUnique },
    invite: { deleteMany: h.prisma.inviteDeleteMany, create: h.prisma.inviteCreate },
    teamspace: { findUnique: h.prisma.teamspaceFindUnique },
    teamspaceInvite: { upsert: h.prisma.teamspaceInviteUpsert },
    teamspaceMember: { upsert: h.prisma.teamspaceMemberUpsert },
    emailConfig: { findUnique: h.prisma.emailConfigFindUnique },
    emailDelivery: { create: h.prisma.emailDeliveryCreate },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { MAIL_NOT_CONFIGURED } from "@/lib/mailer";
import { hashToken } from "@/lib/secrets";
import { sendWorkspaceInviteAction, testEmailAction } from "./email";
import { inviteTeamspaceMemberAction } from "./teamspace-invites";

type Payload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

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
const ORIGIN = "https://app.example.test"; // APP_URL is set WITH a trailing slash

function clearSmtpEnv() {
  for (const key of ENV_KEYS) {
    if (key === "AUTH_SECRET") continue;
    delete process.env[key];
  }
}

function configureSmtp() {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_PORT = "2525";
  process.env.SMTP_FROM = "noema@example.test";
  process.env.SMTP_FROM_NAME = "Noema Env";
  process.env.SMTP_USER = "env-user";
  process.env.SMTP_PASSWORD = SMTP_PASSWORD_CANARY;
}

function expectNoSecrets(blob: string) {
  expect(blob).not.toContain(AUTH_SECRET_CANARY);
  expect(blob).not.toContain(SMTP_PASSWORD_CANARY);
  expect(blob).not.toMatch(/v1:[A-Za-z0-9+/=]+:/); // encryptSecret() envelope
  expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/); // JWT-shaped token
  expect(blob).not.toContain("noema:token:"); // hashToken() domain separator
}

function lastPayload(): Payload {
  const calls = h.transport.sendMail.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Payload;
}

type DeliveryRow = {
  status: string;
  kind: string;
  error: string | null;
  to: string;
  subject: string;
};

function deliveryRow(): DeliveryRow {
  const calls = h.prisma.emailDeliveryCreate.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].data as DeliveryRow;
}

function fail(message: string): never {
  throw new Error(message);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transport.sendMail.mockResolvedValue({ messageId: "m1" });
  h.transport.verify.mockResolvedValue(true);
  h.requireUser.mockResolvedValue({ id: "user-1", name: "Bilel G", email: "bilel@example.test" });
  h.prisma.workspaceMemberFindUnique.mockResolvedValue({ role: "OWNER" });
  h.prisma.workspaceFindUnique.mockResolvedValue({
    name: "Acme",
    slug: "acme",
    ownerId: "owner-1",
    owner: { email: "owner@example.test" },
  });
  h.prisma.userFindUnique.mockResolvedValue(null);
  h.prisma.projectFindUnique.mockResolvedValue(null);
  h.prisma.inviteDeleteMany.mockResolvedValue(0);
  h.prisma.inviteCreate.mockResolvedValue({ id: "inv-1" });
  h.prisma.teamspaceInviteUpsert.mockResolvedValue({ id: "ti-1" });
  h.prisma.emailConfigFindUnique.mockResolvedValue(null);
  h.prisma.emailDeliveryCreate.mockResolvedValue({ id: "del-1" });
  clearSmtpEnv();
  process.env.AUTH_SECRET = AUTH_SECRET_CANARY;
  process.env.APP_URL = `${ORIGIN}/`; // trailing slash on purpose → origin trim
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

// ---------------------------------------------------------------------------
// Workspace invitation template
// ---------------------------------------------------------------------------

describe("workspace invite template (sendWorkspaceInviteAction)", () => {
  it("renders subject, body and CTA with the expected values", async () => {
    configureSmtp();
    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "  New.Client@Example.TEST ",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    expect(res.emailed).toBe(true);
    expect(res.link.startsWith(`${ORIGIN}/invite/`)).toBe(true);

    const payload = lastPayload();
    expect(h.createTransport).toHaveBeenCalledTimes(1); // transport fully mocked
    expect(payload.to).toBe("new.client@example.test"); // normalized
    expect(payload.subject).toBe("Bilel G invited you to Acme");
    expect(payload.text).toContain("You're invited to Acme");
    expect(payload.text).toContain(
      "Bilel G invited you to collaborate in <strong>Acme</strong> on Noema (a member account). " +
        "The link expires in 14 days.",
    );
    expect(payload.text).toContain(res.link);
    expect(payload.html).toContain("<h1");
    expect(payload.html).toContain("You're invited to Acme");
    expect(payload.html).toContain('href="' + res.link + '"');
    expect(payload.html).toContain(">Accept invitation</a>");
    expect(payload.html).toContain("If you weren't expecting this, you can ignore the email.");
    expect(payload.from).toBe('"Noema Env" <noema@example.test>');

    expect(deliveryRow()).toMatchObject({
      status: "sent",
      kind: "workspace-invite",
      to: "new.client@example.test",
      subject: "Bilel G invited you to Acme",
      error: null,
    });
  });

  it("escapes markup in workspace/inviter names for the HTML part only", async () => {
    configureSmtp();
    h.prisma.workspaceFindUnique.mockResolvedValue({
      name: "Acme <Lab> & Co",
      slug: "acme",
      ownerId: "owner-1",
      owner: { email: "owner@example.test" },
    });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "new@example.test",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);
    const payload = lastPayload();

    expect(payload.subject).toBe('Bilel G invited you to Acme <Lab> & Co'); // plain-text subject
    expect(payload.html).toContain("You're invited to Acme &lt;Lab&gt; &amp; Co");
    expect(payload.html).toContain("<strong>Acme &lt;Lab&gt; &amp; Co</strong>");
    expect(payload.html).not.toContain("<Lab>"); // injected tag never survives
    expect(payload.html).not.toContain("<script"); // nothing executable
    expect(res.link).toContain("/invite/");
  });

  it("renders the guest + project wording for a client invitation", async () => {
    configureSmtp();
    h.prisma.projectFindUnique.mockResolvedValue({
      name: "Site relaunch",
      workspaceId: "ws-1",
    });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "client@example.test",
      role: "GUEST",
      projectId: "proj-1",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    const payload = lastPayload();
    expect(payload.text).toContain(
      "on Noema (a client/guest account), as a client on the project <strong>Site relaunch</strong>. " +
        "The link expires in 14 days.",
    );
    expect(payload.subject).toBe("Bilel G invited you to Acme");
    expect(res.emailed).toBe(true);
  });

  it("keeps AUTH_SECRET, SMTP password, envelopes, JWTs and the token HASH out of the email (canary)", async () => {
    configureSmtp();
    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "new@example.test",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    const payload = lastPayload();
    const blob = [payload.from, payload.to, payload.subject, payload.text, payload.html].join("\n");

    // structural: exactly the transport fields leave the process — no auth block
    expect(Object.keys(payload).sort()).toEqual([
      "from",
      "html",
      "replyTo",
      "subject",
      "text",
      "to",
    ]);
    expectNoSecrets(blob);
    expectNoSecrets(JSON.stringify(deliveryRow()));

    // token handling: only the SHA-256 hash is stored; the raw token rides the
    // intended invite link and nothing else.
    const stored = h.prisma.inviteCreate.mock.calls[0][0].data;
    const rawToken = res.link.split("/invite/")[1];
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(stored.token).toBe(hashToken(rawToken));
    expect(stored.token).not.toBe(rawToken);
    expect(blob).not.toContain(stored.token); // hash never emailed
    expect(blob).toContain(rawToken); // the link itself is the point of the mail
  });

  it("fails soft when SMTP is unconfigured: link still returned, nothing sent", async () => {
    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "new@example.test",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    expect(res.emailed).toBe(false);
    expect(res.warning).toBe(MAIL_NOT_CONFIGURED);
    expect(res.link.startsWith(`${ORIGIN}/invite/`)).toBe(true);
    expect(h.createTransport).not.toHaveBeenCalled(); // no real send possible
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    expect(h.prisma.inviteCreate).toHaveBeenCalledTimes(1); // invite row still created
    expect(deliveryRow()).toMatchObject({ status: "skipped", error: MAIL_NOT_CONFIGURED });
    expectNoSecrets(JSON.stringify(res));
    expectNoSecrets(JSON.stringify(deliveryRow()));
  });
});

// ---------------------------------------------------------------------------
// Teamspace invitation template
// ---------------------------------------------------------------------------

describe("teamspace invite template (inviteTeamspaceMemberAction)", () => {
  beforeEach(() => {
    h.prisma.teamspaceFindUnique.mockResolvedValue({
      id: "ts-1",
      name: "Product",
      workspaceId: "ws-1",
      workspace: { slug: "acme" },
    });
  });

  it("renders subject, body and CTA with the expected values", async () => {
    configureSmtp();
    const res = await inviteTeamspaceMemberAction({
      teamspaceId: "ts-1",
      email: "New.Client@Example.TEST",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    expect(res).toEqual({
      ok: true,
      invited: true,
      added: false,
      email: "new.client@example.test",
      link: expect.stringMatching(/^\/invite\/teamspace\/[A-Za-z0-9_-]{20,}$/),
      emailed: true,
    });

    const payload = lastPayload();
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(payload.to).toBe("new.client@example.test");
    expect(payload.subject).toBe("Bilel G invited you to Product");
    expect(payload.text).toContain(
      "Bilel G added you to the <strong>Product</strong> teamspace on Noema. " +
        "This link expires in 14 days.",
    );
    const link = res.link;
    if (!link) fail("teamspace invite must return a link");
    expect(payload.text).toContain(`Join teamspace: ${ORIGIN}${link}`);
    expect(payload.html).toContain(`href="${ORIGIN}${link}"`);
    expect(payload.html).toContain(">Join teamspace</a>");
    expect(deliveryRow()).toMatchObject({ status: "sent", kind: "teamspace-invite" });

    // canaries + at-rest hash never leaves the process
    const blob = [payload.subject, payload.text, payload.html].join("\n");
    expectNoSecrets(blob);
    expectNoSecrets(JSON.stringify(deliveryRow()));
    const stored = h.prisma.teamspaceInviteUpsert.mock.calls[0][0].create;
    const rawToken = link.split("/invite/teamspace/")[1];
    expect(stored.tokenHash).toBe(hashToken(rawToken));
    expect(blob).not.toContain(stored.tokenHash);
    expect(blob).toContain(rawToken);
  });

  it("fails soft when SMTP is unconfigured: link still returned, nothing sent", async () => {
    const res = await inviteTeamspaceMemberAction({
      teamspaceId: "ts-1",
      email: "new@example.test",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    expect(res).toEqual({
      ok: true,
      invited: true,
      added: false,
      email: "new@example.test",
      link: expect.stringMatching(/^\/invite\/teamspace\//),
      emailed: false,
    });
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    expect(h.prisma.teamspaceInviteUpsert).toHaveBeenCalledTimes(1);
    expect(deliveryRow()).toMatchObject({ status: "skipped", error: MAIL_NOT_CONFIGURED });
  });

  it("adds an existing workspace member directly and sends no email at all", async () => {
    configureSmtp(); // SMTP works — still nothing to send
    h.prisma.userFindUnique.mockResolvedValue({ id: "user-9" });

    const res = await inviteTeamspaceMemberAction({
      teamspaceId: "ts-1",
      email: "member@example.test",
    });
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    expect(res).toEqual({ ok: true, invited: false, added: true, email: "member@example.test" });
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    expect(h.prisma.teamspaceInviteUpsert).not.toHaveBeenCalled();
    expect(h.prisma.teamspaceMemberUpsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SMTP test template
// ---------------------------------------------------------------------------

describe("SMTP test email (testEmailAction)", () => {
  it("renders the pinned test template and reports the config source", async () => {
    configureSmtp();
    const res = await testEmailAction("ws-1", "  QA@Example.TEST ");
    if ("error" in res) fail(`expected ok, got error: ${res.error}`);

    expect(res).toEqual({ ok: true, source: "env", sentTo: "qa@example.test" });
    expect(h.transport.verify).toHaveBeenCalledTimes(1); // handshake first

    const payload = lastPayload();
    expect(payload.to).toBe("qa@example.test");
    expect(payload.subject).toBe("Noema · SMTP test");
    expect(payload.text).toContain("Noema test email");
    expect(payload.text).toContain(
      "Your SMTP settings work — invitations will be delivered from this workspace.",
    );
    expect(payload.text).toContain(`Open Noema: ${ORIGIN}`);
    expect(payload.text).toContain("Sent from workspace email settings.");
    expect(payload.html).toContain('href="' + ORIGIN + '"');
    expect(payload.html).toContain(">Open Noema</a>");
    expectNoSecrets([payload.subject, payload.text, payload.html].join("\n"));
    expect(deliveryRow()).toMatchObject({ status: "sent", kind: "test" });
  });

  it("fails soft with the uniform text when SMTP is unconfigured", async () => {
    await expect(testEmailAction("ws-1", "")).resolves.toEqual({ error: MAIL_NOT_CONFIGURED });
    expect(h.transport.verify).not.toHaveBeenCalled();
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.transport.sendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Uniform denials (ops audit: non-managers must not learn anything)
// ---------------------------------------------------------------------------

describe("non-manager denials are uniform (no SMTP/config oracle)", () => {
  const UNIFORM = { error: "Only workspace admins can manage email and invitations." };

  async function assertUniform(role: "MEMBER" | "GUEST" | null) {
    if (role) h.prisma.workspaceMemberFindUnique.mockResolvedValue({ role });
    else {
      h.prisma.workspaceMemberFindUnique.mockResolvedValue(null);
      h.prisma.workspaceFindUnique.mockResolvedValue({
        name: "Acme",
        slug: "acme",
        ownerId: "someone-else",
        owner: { email: "owner@example.test" },
      });
    }

    const withoutSmtp = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "new@example.test",
    });
    configureSmtp();
    const withSmtp = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "new@example.test",
    });

    // identical error whether SMTP is configured or not → no state oracle
    expect(withoutSmtp).toEqual(UNIFORM);
    expect(withSmtp).toEqual(UNIFORM);

    // …and nothing was looked up or sent on the way to that error
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.transport.sendMail).not.toHaveBeenCalled();
    expect(h.prisma.inviteCreate).not.toHaveBeenCalled();
    expect(h.prisma.emailConfigFindUnique).not.toHaveBeenCalled();
    expect(h.prisma.emailDeliveryCreate).not.toHaveBeenCalled();
    expectNoSecrets(JSON.stringify(withSmtp));
  }

  it("denies a member identically in both SMTP states", async () => {
    await assertUniform("MEMBER");
  });

  it("denies a guest identically in both SMTP states", async () => {
    await assertUniform("GUEST");
  });

  it("denies a non-member identically in both SMTP states", async () => {
    await assertUniform(null);
  });

  it("denies teamspace invites with its own uniform admin message", async () => {
    h.prisma.teamspaceFindUnique.mockResolvedValue({
      id: "ts-1",
      name: "Product",
      workspaceId: "ws-1",
      workspace: { slug: "acme" },
    });
    h.prisma.workspaceMemberFindUnique.mockResolvedValue({ role: "MEMBER" });

    const withoutSmtp = await inviteTeamspaceMemberAction({
      teamspaceId: "ts-1",
      email: "new@example.test",
    });
    configureSmtp();
    const withSmtp = await inviteTeamspaceMemberAction({
      teamspaceId: "ts-1",
      email: "new@example.test",
    });

    const TEAMSPACE_UNIFORM = { error: "Only workspace admins can manage teamspace members." };
    expect(withoutSmtp).toEqual(TEAMSPACE_UNIFORM);
    expect(withSmtp).toEqual(TEAMSPACE_UNIFORM);
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.prisma.teamspaceInviteUpsert).not.toHaveBeenCalled();
    expectNoSecrets(JSON.stringify(withSmtp));
  });
});
