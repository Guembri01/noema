import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { settingsFromSsoConnection } from "@/lib/sso/connection";
import { createSamlClient } from "@/lib/sso/saml-client";
import {
  resolveSamlSettings,
  samlAllowedByStrategyList,
  samlEnabled,
  type SamlSettings,
} from "@/lib/sso/saml";

export const runtime = "nodejs";

type LogoutSettings =
  | { ok: true; settings: SamlSettings; workspaceId?: string }
  | { ok: false; workspaceId?: string };

/** Resolve the connection named by `?connection=`, else the env connection. */
async function resolveLogoutSettings(request: Request): Promise<LogoutSettings> {
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connection");
  if (connectionId) {
    const row = await prisma.ssoConnection.findUnique({ where: { id: connectionId } });
    if (!row) return { ok: false };
    const resolved = settingsFromSsoConnection(row, url.origin);
    return resolved.ok
      ? { ok: true, settings: resolved.settings, workspaceId: row.workspaceId }
      : { ok: false, workspaceId: row.workspaceId };
  }
  if (!samlAllowedByStrategyList(process.env) || !samlEnabled(process.env)) {
    return { ok: false };
  }
  const resolved = resolveSamlSettings(process.env, url.origin);
  return resolved.ok ? { ok: true, settings: resolved.settings } : { ok: false };
}

/**
 * Single Logout endpoint. The local session is always destroyed — that is the
 * security-relevant action and a forged request can only end the caller's own
 * session. When a signed `SAMLRequest`/`SAMLResponse` is present, it is
 * validated by `@node-saml/node-saml` first; a rejection is audited but never
 * keeps the local session alive.
 */
async function logout(request: Request): Promise<NextResponse> {
  const resolved = await resolveLogoutSettings(request);
  let reason: string | null = null;

  if (resolved.ok) {
    const client = createSamlClient(resolved.settings);
    try {
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        const samlRequest = form?.get("SAMLRequest");
        const samlResponse = form?.get("SAMLResponse");
        if (typeof samlRequest === "string" && samlRequest.length > 0) {
          await client.validatePostRequestAsync({ SAMLRequest: samlRequest });
        } else if (typeof samlResponse === "string" && samlResponse.length > 0) {
          const result = await client.validatePostResponseAsync({ SAMLResponse: samlResponse });
          if (!result.loggedOut) throw new Error("Not a logout response");
        }
      } else {
        const url = new URL(request.url);
        const samlRequest = url.searchParams.get("SAMLRequest");
        if (samlRequest) {
          await client.validateRedirectAsync(
            Object.fromEntries(url.searchParams) as never,
            url.search,
          );
        }
      }
    } catch {
      reason = "invalid";
    }
  }

  if (resolved.workspaceId) {
    await logActivity({
      workspaceId: resolved.workspaceId,
      actorId: null,
      action: reason ? "sso.logout_failed" : "sso.logout",
      targetType: "workspace",
      targetId: resolved.workspaceId,
      ...(reason ? { meta: { reason } } : {}),
    });
  }

  await destroySession();
  return NextResponse.redirect(new URL("/login", request.url));
}

export async function GET(request: Request) {
  return logout(request);
}

export async function POST(request: Request) {
  return logout(request);
}
