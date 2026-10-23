import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { Link2, Lock } from "lucide-react";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { DocRenderer } from "@/components/doc-renderer";
import { CopyLinkButton } from "@/components/share-dialog";
import {
  coverBannerStyle,
  isSharedPageUnavailable,
  readingMeasure,
  shareIcon,
  sharedPageTitle,
  usesWideMeasure,
} from "@/lib/share-page";
import { Z } from "@/lib/design-tokens";
import { isEmoji, pageIconToCss } from "@/lib/page-icon";
import { shareUnlockCookieName, verifyShareUnlockToken } from "@/lib/secrets";
import { cn } from "@/lib/utils";

/** Public, read-only page reached through a share link. No authentication. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const link = await prisma.shareLink.findUnique({
    where: { token },
    select: {
      indexing: true,
      passwordHash: true,
      expiresAt: true,
      page: { select: { title: true, deletedAt: true } },
    },
  });
  // A page's title is content: it may only be disclosed once the reader may
  // see the page, so the metadata applies the same state check the body makes
  // (password, expiry, deletion). Until then the `<title>` tag and the Open
  // Graph metadata stay generic — the link alone never names the page (B36).
  const unlocked = verifyShareUnlockToken(
    token,
    (await cookies()).get(shareUnlockCookieName(token))?.value,
  );
  return {
    title: sharedPageTitle(link, link?.page, { unlocked }),
    // Honour the publisher's indexing choice; a page that is not indexed is
    // still discoverable over its link, just never crawled.
    robots: link && link.indexing === false ? { index: false, follow: false } : undefined,
  };
}

/** The tasteful dead-end for a missing, deleted or expired link. */
function UnavailableState() {
  return (
    <main className="animate-fade grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 text-center shadow-1">
        <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-muted">
          <Link2 className="h-4 w-4" aria-hidden />
        </span>
        <h1 className="text-xl font-semibold tracking-heading">
          This link is no longer available
        </h1>
        <p className="mt-2 text-sm text-muted">
          The page may have been unpublished or deleted, or the link may have expired.
        </p>
        <Link
          href="/"
          className="focus-ring u-interactive mt-4 inline-flex h-9 items-center justify-center rounded-control bg-action px-4 text-sm font-medium text-action-fg hover:opacity-90"
        >
          Go to Noema
        </Link>
      </div>
    </main>
  );
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
  // A public reader still localises to the signed-in viewer when there is one;
  // an anonymous visitor gets the default catalogue.
  const locale = (await getCurrentUser())?.locale ?? "en";
  const link = await prisma.shareLink.findUnique({
    where: { token },
    include: {
      page: {
        select: {
          title: true,
          icon: true,
          coverUrl: true,
          content: true,
          deletedAt: true,
          type: true,
        },
      },
    },
  });

  if (!link || isSharedPageUnavailable(link, link.page)) {
    return <UnavailableState />;
  }

  // Password-protected links require a verified unlock cookie: the value is an
  // HMAC over the share token and an expiry, keyed by the server secret, so a
  // forged `share_<token>=1` header unlocks nothing (B01).
  const unlocked = verifyShareUnlockToken(
    token,
    (await cookies()).get(shareUnlockCookieName(token))?.value,
  );
  if (link.passwordHash && !unlocked) {
    return (
      <main className="animate-fade grid min-h-screen place-items-center bg-bg px-6">
        <form
          action={`/s/${token}/unlock`}
          method="POST"
          className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-1"
        >
          <span className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-muted">
            <Lock className="h-4 w-4" aria-hidden />
          </span>
          <h1 className="text-xl font-semibold tracking-heading">Password required</h1>
          <p className="mb-4 mt-1 text-sm text-muted">
            This page is protected. Enter the password to continue.
          </p>
          <input
            type="password"
            name="password"
            required
            autoFocus
            placeholder={t(locale, "passwordLabel")}
            className="focus-ring h-10 w-full rounded-control border-control bg-bg px-3 text-sm"
          />
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              Incorrect password.
            </p>
          )}
          <button
            type="submit"
            className="focus-ring u-interactive mt-4 h-10 w-full rounded-control bg-action text-sm font-medium text-action-fg hover:opacity-90"
          >
            Unlock
          </button>
        </form>
      </main>
    );
  }

  const page = link.page;
  const title = page.title || "Untitled";
  // Fail closed: this public surface never accepts writes. The stored mode
  // (ShareLink.permission) is surfaced so viewers know what the publisher chose;
  // editing happens in-app after sign-in, never anonymously here.
  const readOnly = link.permission !== "EDIT";
  const hasDatabase = usesWideMeasure(page);
  const cover = coverBannerStyle(page.coverUrl);
  const icon = shareIcon(page.icon);

  return (
    <div className="min-h-screen bg-bg">
      {/* Minimal sticky top bar: page identity, provenance and a copy affordance. */}
      <header
        className="sticky top-0 border-b border-border bg-bg/85 backdrop-blur print:hidden"
        style={{ zIndex: Z.sticky }}
      >
        <div className="mx-auto flex h-12 w-full max-w-[1100px] items-center gap-3 px-4 sm:px-6">
          <span className="flex min-w-0 items-center gap-2">
            {icon.kind === "emoji" ? (
              <span aria-hidden className="text-base leading-none">
                {icon.value}
              </span>
            ) : icon.kind === "image" ? (
              <span
                aria-hidden
                className="h-4 w-4 shrink-0 rounded-xs bg-cover bg-center bg-no-repeat"
                style={pageIconToCss(icon)}
              />
            ) : null}
            <span className="truncate text-sm font-medium" title={title}>
              {title}
            </span>
          </span>
          <span className="flex-1" />
          <span className="hidden items-center gap-1 text-xs text-muted sm:flex">
            Made with <span className="font-medium text-fg">Noema</span>
          </span>
          <CopyLinkButton value={`/s/${token}`} label="Copy link" iconOnly className="h-8 w-8" />
        </div>
      </header>

      {cover && (
        <div
          role="img"
          aria-label={t(locale, "pageCover")}
          className="w-full bg-cover bg-center"
          style={{
            backgroundImage: cover.backgroundImage,
            backgroundPosition: cover.backgroundPosition,
            aspectRatio: "3 / 1",
            maxHeight: "clamp(140px, 32vh, 360px)",
          }}
        />
      )}

      <main
        className={cn(
          "mx-auto w-full px-4 py-10 sm:px-6 print:px-0 print:py-0",
          readingMeasure(hasDatabase),
        )}
      >
        <article className="animate-fade">
          <header className="mb-6">
            <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted">
              {readOnly ? (
                "Shared page · read-only"
              ) : (
                <>
                  Shared page ·{" "}
                  <a href="/login" className="underline">
                    sign in
                  </a>{" "}
                  to edit in Noema
                </>
              )}
            </p>
            <h1 className="text-page-title font-semibold tracking-title">
              {isEmoji(page.icon) ? `${page.icon} ` : ""}
              {title}
            </h1>
          </header>
          <DocRenderer doc={page.content} />
          <footer className="mt-16 border-t border-border pt-4 text-xs text-muted print:hidden">
            Shared with Noema · MIT-licensed open source
          </footer>
        </article>
      </main>
    </div>
  );
}
