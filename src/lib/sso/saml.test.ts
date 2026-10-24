import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { createSamlClient, samlMetadata } from "./saml-client";
import { createSamlRelayState, readSamlRelayState } from "./saml-relay";
import {
  mapSamlGroupsToRole,
  parseSamlRoleRules,
  resolveSamlSettings,
  samlAssertionId,
  samlAssertionKey,
  samlGroups,
  samlIdentityProfile,
  type SamlSettings,
} from "./saml";

/**
 * Env-level SAML: configuration, metadata, AuthnRequest generation and real
 * validation through `@node-saml/node-saml`. The signed fixture is built in
 * the test with a fresh key pair, so no private key is ever committed.
 */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const IDP_KEY = String(
  privateKey.export({ type: "pkcs8", format: "pem" }),
);
const IDP_CERT = String(publicKey.export({ type: "spki", format: "pem" }));
const IDP_ENTITY = "https://idp.example.com/metadata";
const SP_ENTITY = "https://app.example.com/api/auth/saml/metadata";
const ACS = "https://app.example.com/api/auth/saml/acs";

const ENV = {
  AUTH_SAML_SSO_URL: "https://idp.example.com/sso",
  AUTH_SAML_ENTITY_ID: IDP_ENTITY,
  AUTH_SAML_CERT: IDP_CERT,
  AUTH_SAML_SP_ENTITY_ID: SP_ENTITY,
  AUTH_SAML_CALLBACK_URL: ACS,
  AUTH_SAML_EMAIL_ATTRIBUTE: "email",
};

function settingsFrom(env: Record<string, string> = ENV): SamlSettings {
  const resolved = resolveSamlSettings(env, "https://app.example.com");
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.settings;
}

function roleRules(raw: string) {
  const parsed = parseSamlRoleRules(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.rules;
}

const settings = settingsFrom();

/** A SAML Response with one assertion, signed by the test IdP key. */
function signedResponse(options: {
  audience?: string;
  email?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  assertionId?: string;
  responseId?: string;
} = {}): string {
  const now = Date.now();
  const audience = options.audience ?? SP_ENTITY;
  const email = options.email ?? "alice@example.com";
  const notBefore = options.notBefore ?? new Date(now - 30_000);
  const notOnOrAfter = options.notOnOrAfter ?? new Date(now + 300_000);
  const assertionId = options.assertionId ?? "assertion-1";
  const responseId = options.responseId ?? "response-1";
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${ACS}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${new Date(now).toISOString()}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter.toISOString()}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore.toISOString()}" NotOnOrAfter="${notOnOrAfter.toISOString()}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="name"><saml:AttributeValue>Alice Example</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>eng</saml:AttributeValue><saml:AttributeValue>admins</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;

  const signer = new SignedXml({
    privateKey: IDP_KEY,
    publicCert: IDP_CERT,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: "//*[local-name()='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });
  signer.computeSignature(xml, {
    location: {
      reference: "//*[local-name()='Assertion']/*[local-name()='Issuer']",
      action: "after",
    },
  });
  return Buffer.from(signer.getSignedXml(), "utf8").toString("base64");
}

describe("resolveSamlSettings", () => {
  it("requires the URL, entity id and signing certificate", () => {
    const result = resolveSamlSettings({}, "https://app.example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("AUTH_SAML_SSO_URL");
  });

  it("derives the SP entity id and ACS from the request origin", () => {
    const resolved = resolveSamlSettings(
      {
        AUTH_SAML_SSO_URL: "https://idp.example.com/sso",
        AUTH_SAML_ENTITY_ID: IDP_ENTITY,
        AUTH_SAML_CERT: IDP_CERT,
      },
      "https://app.example.com/",
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.settings.spEntityId).toBe(
        "https://app.example.com/api/auth/saml/metadata",
      );
      expect(resolved.settings.callbackUrl).toBe("https://app.example.com/api/auth/saml/acs");
      expect(resolved.settings.emailAttribute).toContain("emailaddress");
    }
  });

  it("normalises escaped newlines and refuses half-configured keys", () => {
    const resolved = resolveSamlSettings(
      { ...ENV, AUTH_SAML_CERT: IDP_CERT.replace(/\n/g, "\\n") },
      "https://app.example.com",
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.settings.idpCertificate).toContain("\n");

    const half = resolveSamlSettings(
      { ...ENV, AUTH_SAML_PRIVATE_KEY: "key-only" },
      "https://app.example.com",
    );
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.reason).toContain("AUTH_SAML_SP_CERT");
  });

  it("rejects a non-http SSO URL", () => {
    const result = resolveSamlSettings(
      { ...ENV, AUTH_SAML_SSO_URL: "javascript:alert(1)" },
      "https://app.example.com",
    );
    expect(result.ok).toBe(false);
  });
});

describe("metadata and AuthnRequest", () => {
  it("serves SP metadata with the entity id, ACS and SLO locations", () => {
    const xml = samlMetadata({ ...settings, logoutUrl: "https://idp.example.com/slo" });
    expect(xml).toContain(`entityID="${SP_ENTITY}"`);
    expect(xml).toContain(ACS);
    expect(xml).toContain("AssertionConsumerService");
    expect(xml).toContain("SingleLogoutService");
  });

  it("builds a redirect AuthnRequest carrying the RelayState", async () => {
    const url = new URL(
      await createSamlClient(settings).getAuthorizeUrlAsync("relay-state-1", undefined, {}),
    );
    expect(url.origin).toBe("https://idp.example.com");
    expect(url.searchParams.get("SAMLRequest")).toBeTruthy();
    expect(url.searchParams.get("RelayState")).toBe("relay-state-1");
  });
});

describe("assertion validation", () => {
  it("accepts a correctly signed assertion and exposes the profile", async () => {
    const result = await createSamlClient(settings).validatePostResponseAsync({
      SAMLResponse: signedResponse(),
    });
    expect(result.profile?.nameID).toBe("alice@example.com");
    expect(result.profile?.email).toBe("alice@example.com");
    expect(result.profile?.name).toBe("Alice Example");
    expect(samlAssertionId(result.profile as Record<string, unknown>)).toBe("assertion-1");
  });

  it("rejects a tampered signed assertion", async () => {
    const valid = signedResponse();
    const xml = Buffer.from(valid, "base64").toString("utf8");
    const tampered = Buffer.from(
      xml.replace("alice@example.com", "mallory@example.com"),
      "utf8",
    ).toString("base64");
    await expect(
      createSamlClient(settings).validatePostResponseAsync({ SAMLResponse: tampered }),
    ).rejects.toThrow();
  });

  it("rejects an audience mismatch and an expired assertion", async () => {
    await expect(
      createSamlClient(settings).validatePostResponseAsync({
        SAMLResponse: signedResponse({ audience: "https://other.example.com" }),
      }),
    ).rejects.toThrow();

    await expect(
      createSamlClient(settings).validatePostResponseAsync({
        SAMLResponse: signedResponse({
          notBefore: new Date(Date.now() - 600_000),
          notOnOrAfter: new Date(Date.now() - 300_000),
        }),
      }),
    ).rejects.toThrow();
  });
});

describe("identity mapping and replay key", () => {
  it("maps configured attributes and keeps groups", () => {
    const profile = samlIdentityProfile(
      {
        nameID: "alice@example.com",
        email: "ignored@example.com",
        name: "Ignored",
        groups: ["eng", "admins"],
      },
      { ...settings, emailAttribute: "email", nameAttribute: "name" },
    );
    expect(profile.email).toBe("ignored@example.com");
    expect(profile.name).toBe("Ignored");
    expect(profile.groups).toEqual(["eng", "admins"]);
    expect(profile.externalId).toBe("alice@example.com");
  });

  it("keys a response by its stable digest so a byte-for-byte replay collides", () => {
    const first = samlAssertionKey({}, "response-bytes");
    expect(first).toMatch(/^saml:[0-9a-f]{64}$/);
    expect(samlAssertionKey({}, "response-bytes")).toBe(first);
    expect(samlAssertionKey({}, "other-response")).not.toBe(first);
    expect(samlAssertionKey({ ID: "assert-1" }, "response-bytes")).toBe("saml:assert-1");
    expect(
      samlAssertionKey(
        { getAssertion: () => ({ $: { ID: "assert-9" } }) },
        "re-encoded-copy",
      ),
    ).toBe("saml:assert-9");
  });
});

describe("group role mapping", () => {
  it("parses JSON and shorthand rules", () => {
    expect(parseSamlRoleRules('[{"group":"eng","role":"ADMIN"}]')).toEqual({
      ok: true,
      rules: [{ group: "eng", role: "ADMIN" }],
    });
    expect(roleRules("eng:ADMIN,ops:MEMBER")).toEqual([
      { group: "eng", role: "ADMIN" },
      { group: "ops", role: "MEMBER" },
    ]);
  });

  it("never grants OWNER from a directory group", () => {
    const rules = roleRules("owners:OWNER");
    expect(rules).toEqual([{ group: "owners", role: "ADMIN" }]);
    expect(mapSamlGroupsToRole(rules, ["owners"])).toBe("ADMIN");
  });

  it("uses the highest privilege that matches, defaulting to MEMBER", () => {
    const rules = roleRules("eng:ADMIN,ops:MEMBER");
    expect(mapSamlGroupsToRole(rules, ["ops"])).toBe("MEMBER");
    expect(mapSamlGroupsToRole(rules, ["ops", "eng"])).toBe("ADMIN");
    expect(mapSamlGroupsToRole(rules, ["other"])).toBe("MEMBER");
  });

  it("fails closed on malformed rules", () => {
    expect(parseSamlRoleRules("[not json").ok).toBe(false);
    expect(parseSamlRoleRules("eng:SUPERUSER").ok).toBe(false);
    expect(parseSamlRoleRules(":ADMIN").ok).toBe(false);
  });

  it("extracts group arrays from the configured SAML attribute", () => {
    expect(
      samlGroups({ groups: ["eng", "ops"] }, { ...settings, groupsAttribute: "groups" }),
    ).toEqual(["eng", "ops"]);
    expect(
      samlGroups({ roles: "admin" }, { ...settings, groupsAttribute: "roles" }),
    ).toEqual(["admin"]);
  });
});

describe("signed RelayState", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = randomBytes(32).toString("hex");
  });
  afterEach(() => {
    delete process.env.AUTH_SECRET;
  });

  it("round-trips a same-origin return path", async () => {
    const token = await createSamlRelayState("/w/acme/settings");
    expect(await readSamlRelayState(token)).toEqual({ returnTo: "/w/acme/settings" });
  });

  it("normalises an unsafe return path to /app", async () => {
    const token = await createSamlRelayState("//evil.example");
    expect(await readSamlRelayState(token)).toEqual({ returnTo: "/app" });
  });

  it("rejects a malformed or tampered token", async () => {
    const token = await createSamlRelayState("/app");
    expect(await readSamlRelayState("not-a-token")).toBeNull();
    expect(await readSamlRelayState(undefined)).toBeNull();
    const [header, payload, signature] = token.split(".");
    const flipped = `${signature.slice(0, 4)}${signature[4] === "a" ? "b" : "a"}${signature.slice(5)}`;
    expect(await readSamlRelayState(`${header}.${payload}.${flipped}`)).toBeNull();
  });
});
