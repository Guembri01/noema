import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { DocRenderer } from "@/components/doc-renderer";

/** Public, read-only page reached through a share link. No authentication. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const link = await prisma.shareLink.findUnique({
    where: { token },
    select: { page: { select: { title: true } } },
  });
  return { title: link?.page.title || "Shared page" };
}

export default async function PublicSharedPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      page: {
        select: { title: true, icon: true, coverUrl: true, content: true, deletedAt: true },
      },
    },
  });

  if (!link || (link.expiresAt && link.expiresAt < new Date()) || link.page.deletedAt) {
    notFound();
  }

  // Password-protected links require a verified unlock cookie.
  const unlocked = (await cookies()).get(`share_${token}`)?.value === "1";
  if (link.passwordHash && !unlocked) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <form
          action={`/s/${token}/unlock`}
          method="POST"
          className="rounded-xl border border-border bg-surface p-8"
        >
          <h1 className="text-lg font-semibold">Password required</h1>
          <p className="mb-4 mt-1 text-sm text-muted">
            This page is protected. Enter the password to continue.
          </p>
          <input
            type="password"
            name="password"
            required
            autoFocus
            placeholder="Password"
            className="h-10 w-full rounded border border-border bg-bg px-3 text-sm outline-none focus:border-accent"
          />
          {error && <p className="mt-2 text-sm text-red-500">Incorrect password.</p>}
          <button
            type="submit"
            className="mt-4 h-10 w-full rounded bg-accent text-sm text-accent-fg"
          >
            Unlock
          </button>
        </form>
      </main>
    );
  }

  const page = link.page;
  // Fail closed: this public surface never accepts writes. The stored mode
  // (ShareLink.permission) is surfaced so viewers know what the publisher chose;
  // editing happens in-app after sign-in, never anonymously here.
  const readOnly = link.permission !== "EDIT";

  return (
    <main className="mx-auto max-w-3xl px-8 py-14">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
        {readOnly ? (
          "Shared page · read-only"
        ) : (
          <>
            Shared page · anyone with the link can edit —{" "}
            <a href="/login" className="underline">
              sign in
            </a>{" "}
            to edit in Noema
          </>
        )}
      </p>
      <h1 className="mb-6 text-4xl font-bold tracking-tight">
        {page.icon ? `${page.icon} ` : ""}
        {page.title || "Untitled"}
      </h1>
      {page.coverUrl && (
        <div className="mb-8 h-40 rounded-lg" style={{ background: page.coverUrl }} />
      )}
      <DocRenderer doc={page.content} />
      <footer className="mt-16 border-t border-border pt-4 text-xs text-muted">
        Shared with Noema · MIT-licensed open source
      </footer>
    </main>
  );
}
