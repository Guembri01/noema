import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { samlEnabled } from "@/lib/sso/saml";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";
import { SamlLoginChooser } from "@/components/saml-login-chooser";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await getCurrentUser()) redirect("/app");
  const { error, next } = await searchParams;
  const saml = samlEnabled(process.env) && Boolean(process.env.AUTH_SAML_CERT?.trim());
  const samlChoices = (
    await prisma.ssoConnection.findMany({
      where: {
        enabled: true,
        verifiedDomains: { some: { verifiedAt: { not: null } } },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        workspace: { select: { name: true } },
        verifiedDomains: {
          where: { verifiedAt: { not: null } },
          select: { domain: true },
        },
      },
    })
  ).map((connection) => ({
    id: connection.id,
    name: connection.name,
    workspaceName: connection.workspace.name,
    domains: connection.verifiedDomains.map((domain) => domain.domain),
  }));
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your Noema workspace."
    >
      {error === "sso" && (
        <p role="alert" className="mb-4 text-sm text-danger">
          Single sign-on failed.
        </p>
      )}
      {error === "sso_email_taken" && (
        <p role="alert" className="mb-4 text-sm text-danger">
          An account with this email already exists. Sign in with your password
          instead. If you never created that account, ask your administrator for
          help.
        </p>
      )}
      <AuthForm mode="login" next={next} />
      {process.env.SSO_ISSUER && (
        <a
          href="/api/auth/sso/start"
          className="mt-4 block text-center text-sm text-accent hover:underline"
        >
          Sign in with SSO
        </a>
      )}
      {samlChoices.length > 0 ? (
        <SamlLoginChooser choices={samlChoices} />
      ) : saml ? (
        <a
          href="/api/auth/saml/start"
          className="mt-2 block text-center text-sm text-accent hover:underline"
        >
          Sign in with SAML SSO
        </a>
      ) : null}
    </AuthShell>
  );
}
