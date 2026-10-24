import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { linkOrCreate, normalizeIdentity } from "@/lib/auth-strategies";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { settingsFromSsoConnection } from "@/lib/sso/connection";
import { createSamlClient } from "@/lib/sso/saml-client";
import { readSamlRelayState } from "@/lib/sso/saml-relay";
import {
  mapSamlGroupsToRole,
  resolveSamlSettings,
  samlAllowedByStrategyList,
  samlAssertionKey,
  samlEnabled,
  samlGroups,
  samlIdentityProfile,
  samlStrategy,
} from "@/lib/sso/saml";
import { claimSamlAssertion } from "@/server/sso-replay";

export const runtime = "nodejs";

/** Fail closed: never issue a session, always land on the login error. */
function failure(origin: string, error = "sso"): NextResponse {
  return NextResponse.redirect(`${origin}/login?error=${error}`);
}

/**
 * Assertion Consumer Service. The entire SAMLResponse is validated by
 * `@node-saml/node-saml` (signature, audience, destination, conditions, clock
 * skew); this handler only binds it to the browser that started the login,
 * rejects replays, and runs the shared account-linking pipeline.
 */
export async function POST(request: Request) {
  const env = process.env;
  const url = new URL(request.url);
  const origin = url.origin;
  if (!samlAllowedByStrategyList(env)) return failure(origin);

  const form = await request.formData().catch(() => null);
  const samlResponse = form?.get("SAMLResponse");
  const relayState = form?.get("RelayState");
  if (typeof samlResponse !== "string" || samlResponse.length === 0) {
    return failure(origin);
  }

  const relay = await readSamlRelayState(relayState);
  if (!relay) return failure(origin);

  let settings;
  if (relay.connectionId) {
    const row = await prisma.ssoConnection.findUnique({ where: { id: relay.connectionId } });
    if (!row) return failure(origin);
    settings = settingsFromSsoConnection(row, origin);
  } else {
    settings = resolveSamlSettings(env, origin);
    if (settings.ok && !samlEnabled(env)) return failure(origin);
  }
  if (!settings.ok) return failure(origin);

  let profile: Record<string, unknown> | null;
  try {
    const result = await createSamlClient(settings.settings).validatePostResponseAsync({
      SAMLResponse: samlResponse,
    });
    profile = (result.profile ?? null) as Record<string, unknown> | null;
  } catch {
    return failure(origin);
  }
  if (!profile) return failure(origin);

  const strategy = samlStrategy(settings.settings);
  const identity = normalizeIdentity(
    strategy,
    samlIdentityProfile(profile, settings.settings),
  );
  if (!identity.email) return failure(origin);

  // R10.4: check-and-insert the response digest before any user write. A
  // repeated submission must not create/link/issue a session a second time.
  try {
    const fresh = await claimSamlAssertion(samlAssertionKey(profile, samlResponse));
    if (!fresh) return failure(origin);
  } catch {
    return failure(origin);
  }

  const existingUsers = await prisma.user.findMany({
    where: { email: identity.email },
    select: { id: true, email: true, emailVerified: true },
  });
  // A signed assertion vouches for the address, exactly like the OIDC
  // `email_verified: true` path; an existing account still needs its own
  // proof before it can be linked (account pre-hijacking, B07).
  const decision = linkOrCreate({
    existingUsers,
    identity,
    strategy,
    now: Date.now(),
    emailVerified: true,
  });

  let userId: string;
  if (decision.action === "link") {
    userId = decision.userId;
  } else if (decision.action === "create") {
    const created = await prisma.user.create({
      data: {
        email: identity.email,
        name: identity.name || identity.email.split("@")[0],
        passwordHash: `sso:${randomToken(24)}`,
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = created.id;
  } else {
    if (decision.reason === "email_taken_unverified") {
      return failure(origin, "sso_email_taken");
    }
    return failure(origin);
  }

  // Optional directory-driven auto-join. The mapping may grant ADMIN/MEMBER,
  // never OWNER; an existing OWNER is left untouched so a login can never
  // demote the human who owns the workspace.
  if (settings.settings.workspaceId) {
    const role = mapSamlGroupsToRole(
      settings.settings.roleRules,
      samlGroups(profile, settings.settings),
    );
    try {
      const existing = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: settings.settings.workspaceId,
            userId,
          },
        },
        select: { role: true },
      });
      if (existing?.role !== "OWNER") {
        await prisma.workspaceMember.upsert({
          where: {
            workspaceId_userId: {
              workspaceId: settings.settings.workspaceId,
              userId,
            },
          },
          create: {
            workspaceId: settings.settings.workspaceId,
            userId,
            role,
          },
          update: { role },
        });
      }
    } catch {
      return failure(origin);
    }
  }

  await createSession(userId);
  return NextResponse.redirect(`${origin}${relay.returnTo}`);
}
