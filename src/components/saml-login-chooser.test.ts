import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SamlLoginChooser } from "./saml-login-chooser";

describe("SamlLoginChooser", () => {
  it("renders the email field and each connection link", () => {
    const html = renderToStaticMarkup(
      createElement(SamlLoginChooser, {
        choices: [
          { id: "a", name: "Okta", workspaceName: "Acme", domains: ["acme.com"] },
          { id: "b", name: "Entra", workspaceName: "Beta", domains: ["beta.com"] },
        ],
      }),
    );
    expect(html).toContain("Sign in with SAML SSO");
    expect(html).toContain("Work email for SAML SSO");
    expect(html).toContain("/api/auth/saml/start?connection=a");
    expect(html).toContain("Okta");
    expect(html).toContain("Acme");
  });
});
