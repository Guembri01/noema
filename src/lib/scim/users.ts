/** SCIM 2.0 helpers for the Users endpoints (R10.20). Pure, no network/DB. */

export type ScimUserInput = {
  email: string;
  name: string;
  active: boolean;
};

export type ScimUserResource = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"];
  id: string;
  userName: string;
  name: { formatted: string };
  emails: { value: string; primary: true }[];
  active: boolean;
  meta: { resourceType: "User" };
};

export type ScimListResponse<T> = {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse a SCIM User payload (userName, emails, name/displayName, active). */
export function parseScimUser(body: unknown): ScimUserInput | null {
  const input = record(body);
  if (!input) return null;
  const emails = Array.isArray(input.emails) ? input.emails : [];
  const primary =
    emails.find((entry) => record(entry)?.primary === true) ?? emails[0];
  const email =
    string(input.userName) ||
    string(record(primary)?.value) ||
    string(record(record(input.emails)?.[0])?.value);
  if (!email || !email.includes("@")) return null;
  const name = record(input.name);
  const formatted =
    string(name?.formatted) ||
    [string(name?.givenName), string(name?.familyName)].filter(Boolean).join(" ") ||
    string(input.displayName) ||
    email.split("@")[0];
  return { email: email.toLowerCase(), name: formatted, active: input.active !== false };
}

/** Read `active` out of SCIM PATCH Operations (`replace` path=active). */
export function parseScimPatch(body: unknown): { active?: boolean } | null {
  const input = record(body);
  if (!input || !Array.isArray(input.Operations)) return null;
  for (const operation of input.Operations) {
    const op = record(operation);
    if (!op) continue;
    const path = string(op.path).toLowerCase();
    if (path === "active" && typeof op.value === "boolean") return { active: op.value };
  }
  return null;
}

export function scimUserResource(input: {
  id: string;
  email: string;
  name: string;
  active?: boolean;
}): ScimUserResource {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: input.id,
    userName: input.email,
    name: { formatted: input.name || input.email.split("@")[0] },
    emails: [{ value: input.email, primary: true }],
    active: input.active !== false,
    meta: { resourceType: "User" },
  };
}

export function scimList<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
): ScimListResponse<T> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): Response {
  return new Response(
    JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    }),
    { status, headers: { "content-type": "application/scim+json" } },
  );
}

/** Hash a bearer token for storage/lookup; the plaintext never reaches the DB. */
export async function hashScimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
