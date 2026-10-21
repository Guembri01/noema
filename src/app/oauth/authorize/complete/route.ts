import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { bodyReadError, readFormDataBody } from "@/lib/body-limit";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { hashOAuthSecret } from "@/lib/api-auth";

export const runtime = "nodejs";

/**
 * B22 — the budget for one approval. The form carries the client id, the
 * redirect URI, the state and the PKCE challenge — a few hundred bytes.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Issue an authorization code after the user approves (or denies) an app. */
export async function POST(request: Request) {
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
