import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { bodyReadError, readFormDataBody } from "@/lib/body-limit";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { hashOAuthSecret } from "@/lib/api-auth";
import { allowedOrigins } from "../../../../../scripts/desktop/allowed-origins.cjs";

export const runtime = "nodejs";

/**
 * B22 — the budget for one approval. The form carries the client id, the
 * redirect URI, the state and the PKCE challenge — a few hundred bytes.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Validate the browser's Origin without deriving trust from request.url/Host.
 * APP_URL is the configured public origin; APP_ORIGINS and the local addresses
 * come from the same trusted allow-list used for Server Actions.
 */
function hasTrustedOrigin(rawOrigin: string | null): boolean {
  if (!rawOrigin) return false;

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.origin === "null" ||
    rawOrigin !== origin.origin
  ) {
    return false;
  }

  for (const configured of [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    if (!configured?.trim()) continue;
    try {
      const configuredOrigin = new URL(configured.trim());
      if (
        (configuredOrigin.protocol === "http:" || configuredOrigin.protocol === "https:") &&
        configuredOrigin.origin === origin.origin
      ) {
        return true;
      }
    } catch {
      // A malformed deployment URL is not trusted.
    }
  }

  // APP_ORIGINS accepts either absolute origins or bare host[:port] entries.
  // Preserve the scheme when one is configured; a bare host is an explicit
  // host-level trust entry, as it is for Server Actions.
  for (const configured of (process.env.APP_ORIGINS ?? "").split(",")) {
    const value = configured.trim();
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) {
      try {
        const configuredOrigin = new URL(value);
        if (
          (configuredOrigin.protocol === "http:" || configuredOrigin.protocol === "https:") &&
          !configuredOrigin.username &&
          !configuredOrigin.password &&
          configuredOrigin.pathname === "/" &&
          !configuredOrigin.search &&
          !configuredOrigin.hash &&
          configuredOrigin.origin === origin.origin
        ) {
          return true;
        }
      } catch {
        // A malformed allow-list entry is not trusted.
      }
      continue;
    }

    if (originMatchesHost(origin, value)) return true;
  }

  // Use the shared Server Actions helper for this machine's local addresses,
  // excluding APP_ORIGINS above so URL entries retain their exact scheme.
  return allowedOrigins({ env: { ...process.env, APP_ORIGINS: "" } }).some((host) =>
    originMatchesHost(origin, host),
  );
}

/** Match a configured host[:port] entry against either HTTP authority form. */
function originMatchesHost(origin: URL, host: string): boolean {
  if (/[/?#@]/.test(host)) return false;
  return ["http:", "https:"].some((protocol) => {
    try {
      return new URL(`${protocol}//${host}`).host === origin.host;
    } catch {
      return false;
    }
  });
}

/** Issue an authorization code after the user approves (or denies) an app. */
export async function POST(request: Request) {
  if (!hasTrustedOrigin(request.headers.get("origin"))) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await readFormDataBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Expected multipart form data");
  }
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const decision = String(form.get("decision") ?? "deny");
  const codeChallenge = String(form.get("code_challenge") ?? "");
  const codeChallengeMethod = String(form.get("code_challenge_method") ?? "").toUpperCase();

  const app = await prisma.oAuthApp.findUnique({ where: { clientId } });
  if (!app || !app.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const url = new URL(redirectUri);
  if (decision !== "allow") {
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    return NextResponse.redirect(url.toString(), 303);
  }

  // RFC 7636: apps flagged `requiresPkce` must present an S256 challenge.
  if (app.requiresPkce && (codeChallenge.length === 0 || codeChallengeMethod !== "S256")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const code = randomToken(24);
  await prisma.oAuthCode.create({
    data: {
      // Only the digest is stored; the plaintext code goes into the redirect.
      codeHash: hashOAuthSecret(code),
      clientId,
      userId: user.id,
      redirectUri,
      // RFC 7636 §4.3: an omitted method defaults to `plain`.
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallenge ? codeChallengeMethod || "PLAIN" : null,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });

  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString(), 303);
}
