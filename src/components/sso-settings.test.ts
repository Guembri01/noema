import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/sso-connections", () => ({
  createSsoConnectionAction: vi.fn(),
  updateSsoConnectionAction: vi.fn(),
  deleteSsoConnectionAction: vi.fn(),
  refreshSsoConnectionMetadataAction: vi.fn(),
}));
vi.mock("@/server/actions/verified-domains", () => ({
  addVerifiedDomainAction: vi.fn(),
  verifyVerifiedDomainAction: vi.fn(),
  deleteVerifiedDomainAction: vi.fn(),
}));

import { SsoSettings } from "./sso-settings";

const connection = {
  id: "conn-1",
  name: "Acme Okta",
  idpEntityId: "https://idp.example.com/metadata",
  ssoUrl: "https://idp.example.com/sso",
  certificate: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
  metadataUrl: "https://idp.example.com/metadata.xml",
  metadataFetchedAt: "2026-01-01T00:00:00.000Z",
  spEntityId: null,
  callbackUrl: null,
  emailAttribute: "email",
  nameAttribute: null,
  groupsAttribute: "groups",
  roleRules: "eng:ADMIN",
  enabled: true,
  scimEnabled: false,
};

describe("SsoSettings", () => {
  it("renders connections, metadata refresh and pending-domain TXT instructions", () => {
    const html = renderToStaticMarkup(
      createElement(SsoSettings, {
        workspaceId: "ws-1",
        locale: "en",
        connections: [connection],
        domains: [
          {
            id: "d1",
            domain: "acme.com",
            recordName: "_noema-verification.acme.com",
            verifyToken: "token-1",
            verifiedAt: null,
            connectionId: "conn-1",
          },
          {
            id: "d2",
            domain: "verified.com",
            recordName: "_noema-verification.verified.com",
            verifyToken: "token-2",
            verifiedAt: "2026-01-01T00:00:00.000Z",
            connectionId: null,
          },
        ],
      }),
    );
    expect(html).toContain("Single sign-on");
    expect(html).toContain("Acme Okta");
    expect(html).toContain("https://idp.example.com/sso");
    expect(html).toContain("_noema-verification.acme.com");
    expect(html).toContain("token-1");
    expect(html).toContain("verified");
    expect(html).toContain("Verified domains");
  });

  it("renders the empty states", () => {
    const html = renderToStaticMarkup(
      createElement(SsoSettings, {
        workspaceId: "ws-1",
        locale: "en",
        connections: [],
        domains: [],
      }),
    );
    expect(html).toContain("No workspace SAML connection yet.");
    expect(html).toContain("No verified domain yet.");
  });
});
