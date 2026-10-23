import Link from "next/link";
import { Check, Database, FileText, HardDrive } from "lucide-react";
import { NoemaWordmark } from "@/components/brand/noema-wordmark";

/**
 * The shared frame for the two account surfaces.
 *
 * Before this component, sign-in and sign-up each owned a slightly different
 * centred card with no product mark: the first screen of the product looked
 * like a generic form. The frame keeps the form itself untouched, puts the real
 * Noema lockup and a short, factual description of the product beside it, and
 * collapses to one column before the card gets cramped.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main id="main" className="relative min-h-screen overflow-hidden bg-bg">
      <div
        aria-hidden
        className="pointer-events-none absolute -start-40 -top-48 h-[32rem] w-[32rem] rounded-full bg-surface-2/70 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -end-48 top-1/3 h-[28rem] w-[28rem] rounded-full bg-surface-2/50 blur-3xl"
      />

      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:gap-20 lg:py-16">
        <section className="hidden min-w-0 flex-col lg:flex">
          <Link href="/" className="focus-ring w-fit rounded-md">
            <NoemaWordmark />
          </Link>

          <p className="mt-14 inline-flex w-fit items-center gap-2 rounded-full border border-border bg-bg/80 px-3 py-1 text-xs font-medium text-muted shadow-1">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            Local-first · Open source
          </p>
          <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold tracking-title">
            Your workspace, on your machine.
          </h2>
          <p className="mt-4 max-w-lg text-base leading-relaxed text-muted">
            Notes, docs, databases and projects share one page model. Noema runs
            on your own Postgres, or as a desktop app that needs nothing else
            installed.
          </p>

          <ul className="mt-8 grid max-w-lg gap-3 text-sm">
            {[
              [FileText, "Write in blocks, not in someone else's format."],
              [Database, "Turn any page into a typed database with six views."],
              [HardDrive, "Keep the data, the backups and the keys on your side."],
            ].map(([Icon, copy]) => {
              const FeatureIcon = Icon as typeof FileText;
              return (
                <li key={String(copy)} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-surface text-muted">
                    <FeatureIcon className="size-4" aria-hidden />
                  </span>
                  <span className="leading-relaxed text-muted">{copy as string}</span>
                </li>
              );
            })}
          </ul>

          <div className="mt-10 flex items-center gap-5 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3.5 text-success" aria-hidden /> MIT licensed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3.5 text-success" aria-hidden /> No cloud account
            </span>
          </div>
        </section>

        <section className="w-full min-w-0 justify-self-center lg:justify-self-end">
          <div className="mb-8 lg:hidden">
            <Link href="/" className="focus-ring inline-flex rounded-md">
              <NoemaWordmark />
            </Link>
          </div>

          <div className="rounded-lg border border-border bg-bg p-6 shadow-2 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-heading">{title}</h1>
            <p className="mb-6 mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>
            {children}
          </div>

          {footer ? <div className="mt-5">{footer}</div> : null}

          <p className="mt-6 text-center text-xs text-fg-subtle">
            Self-hosted · Open source · MIT licensed
          </p>
        </section>
      </div>
    </main>
  );
}
