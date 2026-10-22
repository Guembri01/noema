import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  if (await getCurrentUser()) redirect("/app");
  return (
    <AuthShell
      title="Create your account"
      subtitle="Start a workspace in seconds. No credit card, no cloud."
    >
      <AuthForm mode="signup" />
    </AuthShell>
  );
}
