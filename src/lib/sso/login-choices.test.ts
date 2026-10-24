import { describe, expect, it } from "vitest";
import { matchSamlConnections } from "./login-choices";

const choices = [
  { id: "a", name: "Okta", workspaceName: "Acme", domains: ["acme.com"] },
  { id: "b", name: "Entra", workspaceName: "Beta", domains: ["beta.com"] },
];

describe("matchSamlConnections", () => {
  it("matches the email domain case-insensitively", () => {
    expect(matchSamlConnections(choices, "Alice@ACME.com")).toEqual([choices[0]]);
    expect(matchSamlConnections(choices, "bob@other.com")).toEqual([]);
  });

  it("returns no match for an invalid email", () => {
    expect(matchSamlConnections(choices, "not-an-email")).toEqual([]);
    expect(matchSamlConnections(choices, "")).toEqual([]);
  });
});
