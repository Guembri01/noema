import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { settingsFromSsoConnection } from "@/lib/sso/connection";
import { samlMetadata } from "@/lib/sso/saml-client";
import { resolveSamlSettings } from "@/lib/sso/saml";

export const runtime = "nodejs";

/**
 * Service-provider metadata for the env-level SAML connection. IdPs consume
 * this URL directly (Okta "Metadata URL", Azure "Federation metadata URL",
 * Google "IDP metadata"). It is public by design: it contains the entity id,
 * ACS/SLO endpoints and public certificates, never a private key.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connection");
  const settings = connectionId
    ? await prisma.ssoConnection
        .findUnique({ where: { id: connectionId } })
        .then((row) =>
          row
            ? settingsFromSsoConnection(row, url.origin)
            : ({ ok: false, reason: "That SAML connection does not exist." } as const),
        )
    : resolveSamlSettings(process.env, url.origin);
  if (!settings.ok) {
    return NextResponse.json({ error: settings.reason }, { status: 404 });
  }

  let metadata: string;
  try {
    metadata = samlMetadata(settings.settings);
  } catch {
    return NextResponse.json(
      { error: "SAML metadata could not be generated." },
      { status: 500 },
    );
  }

  return new NextResponse(metadata, {
    status: 200,
    headers: {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
