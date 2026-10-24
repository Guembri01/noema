/** Login-page SAML chooser: match a typed email domain to a connection. */

import { emailDomain } from "./domains";

export type SamlLoginChoice = {
  id: string;
  name: string;
  workspaceName: string;
  domains: string[];
};

/** Connections whose verified domain matches the email's domain. */
export function matchSamlConnections(
  choices: readonly SamlLoginChoice[],
  email: string,
): SamlLoginChoice[] {
  const domain = emailDomain(email);
  if (!domain) return [];
  return choices.filter((choice) =>
    choice.domains.some((candidate) => candidate.toLowerCase() === domain),
  );
}
