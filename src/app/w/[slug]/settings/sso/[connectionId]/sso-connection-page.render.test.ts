import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render wiring for settings → Single sign-on → one IdP connection.
 *
 * The list page owns the workspace-wide list; this page is the admin-only
 * per-connection surface. These tests pin the gate, the connection lookup and
 * the connection-specific values (ACS/metadata URLs, status, test control)
 * that must reach the markup.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const permissions = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const queries = vi.hoisted(() => ({ getWorkspaceBySlug: vi.fn() }));
const db = vi.hoisted(() => ({ findFirst: vi.fn() }));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: permissions.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({ getWorkspaceBySlug: queries.getWorkspaceBySlug }));
vi.mock("@/lib/db", () => ({ prisma: { ssoConnection: db } }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "app.example.com", "x-forwarded-proto": "https" })),
}));
vi.mock("next/navigation", () => ({
  notFound: navigation.notFound,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/acme/settings/sso/conn-1",
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});
vi.mock("@/server/actions/sso-connections", () => ({
  createSsoConnectionAction: vi.fn(),
  updateSsoConnectionAction: vi.fn(),
  testSsoConnectionAction: vi.fn(),
}));

import SsoConnectionPage from "./page";

const CERT = `-----BEGIN CERTIFICATE-----\n${((
  "MIIDKDCCAhCgAwIBAgIQMGT0HvlPoZRAxt9z7wRYcTANBgkqhkiG9w0BAQsFADAZMRcwFQYDVQQDDA5ub2VtYS10ZXN0LWlkcDAeFw0xOTEyMzEyMjAwMDBaFw0zOTEyMzEyMjAwMDBaMBkxFzAVBgNVBAMMDm5vZW1hLXRlc3QtaWRwMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvpeo+jeVRoAGIzb9CgpLUEWb25pBQ8kWe9IyH6jxzYcGk4Xl74fICQfYYNF11vTTO0i8rZ8WieI36fxOyF5WWnbojB4IrPuaFHzqCh9VUsnURXDmXmBgb8nTLixb8auL7FFZPmWsTcvQl080m8zw84HyFRQak1aPY1nn+YGJLjLfDx6CNmMvxRrtNt3AoueJBjpEfRp1UDTtdukvTc4fhLJ16f5Fe7EhqfWloAoCD5mFB/Uj7NgQnBUU7P5SAkYKSYtzw8EJX7fRwCeprbOycDnfSmn2lX5XKp2s1rQwjqZK8EW37UaV31mRyviSziRF8T8V/qpkUE/EzkfnanFNrQIDAQABo2wwajAOBgNVHQ8BAf8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwIGCCsGAQUFBwMBMBoGA1UdEQQTMBGCD2lkcC5leGFtcGxlLmNvbTAdBgNVHQ4EFgQUpcF16JACCSCLQqcBGZ9mvzKWhF4wDQYJKoZIhvcNAQELBQADggEBAKjTcfUld5sKWTQPMImZefNE0Rg9P4fvjWjKbWBDeGzbDbZBucFoyRst9OYVI/KvliMBLPZFwF1v40K3E6n+vGfmLDE5hwWN1o/XWZxeDnVXy4XH/2W9RLs+mUsCdV5xOZYlIK5+OkwBHgxZeapRrf6xEMTsSiuvmX32CyY5J4K1I7Z5gqdKt3Pb0/rdn6Gnh2rtJOaeGNVOTX2Q5lpixLiazAEURM8+l2GdQcI4adPHbU7KBJ4CtgYkUedOubKS6ptLzmfHknqSTgMiHkdhLMyelEHdJlQ55YY6Msnq5n6ncW8UCi3hNfzSM/l270xeHUghw8E2B7lp9YdqUaJynOU="
).match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----`;

const CONNECTION = {
  id: "conn-1",
  name: "Acme Okta",
  idpEntityId: "https://idp.example.com/metadata",
  ssoUrl: "https://idp.example.com/sso",
  certificate: CERT,
  metadataUrl: "https://idp.example.com/metadata.xml",
  metadataFetchedAt: new Date("2026-10-01T00:00:00.000Z"),
  prevCertificate: null,
  prevCertificateExpiresAt: null,
  spEntityId: null,
  callbackUrl: null,
  emailAttribute: "email",
  nameAttribute: "name",
  groupsAttribute: "groups",
  roleRules: [{ group: "eng", role: "ADMIN" }],
  enabled: true,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

async function renderPage() {
  return renderToStaticMarkup(
    await SsoConnectionPage({
      params: Promise.resolve({ slug: "acme", connectionId: "conn-1" }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1", locale: "en" });
  queries.getWorkspaceBySlug.mockResolvedValue({ id: "ws-1", name: "Acme", slug: "acme" });
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  db.findFirst.mockResolvedValue(CONNECTION);
});

describe("SAML per-connection settings page", () => {
  it("renders the connection-specific SP URLs, status and test control", async () => {
    const html = await renderPage();

    expect(db.findFirst).toHaveBeenCalledWith({
      where: { id: "conn-1", workspaceId: "ws-1" },
      select: expect.any(Object),
    });
    expect(html).toContain("Acme Okta");
    expect(html).toContain("https://app.example.com/api/auth/saml/acs");
    expect(html).toContain(
      "https://app.example.com/api/auth/saml/metadata?connection=conn-1",
    );
    expect(html).toContain("https://app.example.com/api/auth/saml/slo?connection=conn-1");
    expect(html).toContain("Valid until");
    expect(html).toContain("Last fetched");
    expect(html).toContain("Test connection");
    expect(html).toContain("Edit connection");
    expect(html).toContain('href="/w/acme/settings#sso-heading"');
    // A rendered form is not a test result: the success claim appears only
    // after the action returns a passing report.
    expect(html).not.toContain("All checks passed");
    // The public IdP certificate may appear in the edit form; a private key
    // never belongs on this page.
    expect(html).not.toContain("PRIVATE KEY");
  });

  it("shows the manual metadata state when no URL is configured", async () => {
    db.findFirst.mockResolvedValue({
      ...CONNECTION,
      metadataUrl: null,
      metadataFetchedAt: null,
    });

    const html = await renderPage();

    expect(html).toContain("Manual fields (no metadata URL)");
    expect(html).not.toContain("Last fetched");
  });

  it("404s a non-admin before reading the connection", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("404s a connection that is not in this workspace", async () => {
    db.findFirst.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
  });
});
