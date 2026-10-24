import { describe, expect, it } from "vitest";
import { parseIdpMetadata } from "./metadata";

const CERT_A = Buffer.from("certificate-a").toString("base64");
const CERT_B = Buffer.from("certificate-b").toString("base64");

function metadataXml(certs = [CERT_A]): string {
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/metadata">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${certs
      .map(
        (cert) =>
          `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`,
      )
      .join("")}
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/slo"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

describe("parseIdpMetadata", () => {
  it("extracts the entity id, SSO URL, signing certificates and SLO URL", async () => {
    const result = await parseIdpMetadata(metadataXml([CERT_A, CERT_B]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.entityId).toBe("https://idp.example.com/metadata");
    expect(result.metadata.ssoUrl).toBe("https://idp.example.com/sso");
    expect(result.metadata.logoutUrl).toBe("https://idp.example.com/slo");
    expect(result.metadata.certificates).toHaveLength(2);
    expect(result.metadata.certificates[0]).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("reads a federation EntitiesDescriptor wrapper", async () => {
    const wrapped = `<EntitiesDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata">${metadataXml()}</EntitiesDescriptor>`;
    const result = await parseIdpMetadata(wrapped);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata.ssoUrl).toBe("https://idp.example.com/sso");
  });

  it("fails closed on empty, malformed, certificate-less and SSO-less metadata", async () => {
    await expect(parseIdpMetadata("")).resolves.toMatchObject({ ok: false });
    await expect(parseIdpMetadata("<not-xml")).resolves.toMatchObject({ ok: false });
    await expect(
      parseIdpMetadata(metadataXml([])),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("signing certificate") });

    const noSso = metadataXml().replace(
      /<SingleSignOnService[^>]*\/>/,
      '<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="javascript:alert(1)"/>',
    );
    await expect(parseIdpMetadata(noSso)).resolves.toMatchObject({ ok: false });
  });
});
