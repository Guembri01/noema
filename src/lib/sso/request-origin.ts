/**
 * The public origin of the current request, for the copyable SAML SP URLs.
 *
 * Next's request-store APIs throw outside a request scope (static rendering,
 * unit tests), so the same guarded pattern the root layout uses applies here:
 * degrade to a local default instead of taking the settings page down.
 */

import { headers } from "next/headers";

export const DEFAULT_REQUEST_ORIGIN = "http://localhost:3000";

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}

export async function requestOrigin(): Promise<string> {
  try {
    const values = await headers();
    const host =
      firstHeaderValue(values.get("x-forwarded-host")) ??
      firstHeaderValue(values.get("host"));
    if (!host) return DEFAULT_REQUEST_ORIGIN;
    const proto =
      firstHeaderValue(values.get("x-forwarded-proto")) === "https" ? "https" : "http";
    return `${proto}://${host}`;
  } catch {
    return DEFAULT_REQUEST_ORIGIN;
  }
}
