/**
 * Shared result shapes for the SSO dry-run, split out from the server-only
 * implementation so a client component can render a report without importing
 * `node:crypto` (the client-bundle guard rejects that).
 */

export type SsoConnectionTestCheck = {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail: string;
};

export type SsoConnectionTestReport = {
  passed: boolean;
  checks: SsoConnectionTestCheck[];
};
