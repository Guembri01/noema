import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await getCurrentUser()) redirect("/app");
  const { error, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-xl border border-border bg-surface p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          Sign in to your Noema workspace.
        </p>
        {error === "sso" && (
          <p className="mb-4 text-sm text-danger">Single sign-on failed.</p>
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
      </div>
    </main>
  );
}
