import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Code2,
  Database,
  FileText,
  HardDrive,
  Network,
  Search,
  ShieldCheck,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { insideDesktopShell } from "@/lib/security-headers";
import {
  PROJECT_REPOSITORY,
  projectAuthorLine,
} from "@/lib/project-info";
import { Button } from "@/components/ui/button";
import { NoemaWordmark } from "@/components/brand/noema-wordmark";
import { t } from "@/lib/i18n";

const FEATURES = [
  {
    icon: FileText,
    title: "A block editor that stays out of the way",
    body: "Headings, lists, to-dos, quotes, code, math, tables and callouts — all in one calm canvas.",
  },
  {
    icon: Database,
    title: "Databases without the spreadsheet tax",
    body: "Typed properties, table, board, list, gallery, calendar, timeline and chart views over the same pages.",
  },
  {
    icon: Network,
    title: "Pages all the way down",
    body: "Documents, folders and rows share one model, so nesting, moving and linking never needs a second concept.",
  },
  {
    icon: Search,
    title: "Find the thought again",
    body: "Full-text search, page history, comments and backlinks are built in — not bolted on as a paid add-on.",
  },
  {
    icon: HardDrive,
    title: "Your machine is the server",
    body: "Run the web app against your own Postgres, or install the desktop build that starts its own database.",
  },
  {
    icon: Code2,
    title: "Open by construction",
    body: "MIT licensed, readable TypeScript, and no lock-in on the data you put into it.",
  },
] as const;

export default async function Home() {
  const user = await getCurrentUser();
  if (user) redirect("/app");

  // The installed app is not a marketing surface. Someone who installed Noema
  // wants either their workspace or, on a brand-new install, the "create your
  // account" form — never a landing page advertising features they already
  // downloaded. The site version deliberately keeps the landing page: its job
  // is to explain the product.
  if (insideDesktopShell()) {
    const users = await prisma.user.count();
    redirect(users === 0 ? "/signup" : "/login");
  }

  return (
    <main id="main" className="relative overflow-hidden bg-bg">
      <div
        aria-hidden
        className="pointer-events-none absolute -start-52 -top-52 size-128 rounded-full bg-accent-soft blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -end-56 top-[26rem] size-120 rounded-full bg-warning-soft blur-3xl"
      />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-6">
        <NoemaWordmark href="/" />
        <nav aria-label={t("en", "primaryNav")} className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/signup">Get started</Link>
          </Button>
        </nav>
      </header>

      <section className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 lg:grid-cols-[1.02fr_1fr] lg:gap-16 lg:pb-28 lg:pt-16">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-bg/85 px-3 py-1 text-xs font-medium text-muted shadow-1">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            Self-hosted · Open source · MIT
          </p>
          <h1 className="mt-5 max-w-2xl text-balance text-4xl font-semibold tracking-title sm:text-5xl lg:text-6xl">
            A local-first workspace for notes, docs and databases.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Noema is an open-source alternative for teams and individuals who
            want their workspace close to the data. Everything is a page —
            documents, folders and database rows share one model.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" asChild>
              <Link href="/signup">
                Create your workspace
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
            <Button variant="secondary" size="lg" asChild>
              <a
                href={PROJECT_REPOSITORY}
                target="_blank"
                rel="noreferrer noopener"
              >
                View source
              </a>
            </Button>
          </div>
          <p className="mt-4 text-xs text-fg-subtle">
            No cloud account required · Runs on your own Postgres · MIT licensed
          </p>
        </div>

        <div className="relative min-w-0">
          <div
            aria-hidden
            className="absolute -inset-5 rounded-xl bg-accent-soft blur-2xl"
          />
          <figure className="relative overflow-hidden rounded-lg border border-border bg-bg shadow-3">
            <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5">
              <span className="flex gap-1.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-danger/70" />
                <span className="size-2.5 rounded-full bg-warning/80" />
                <span className="size-2.5 rounded-full bg-success/80" />
              </span>
              <span className="min-w-0 flex-1 text-center text-2xs text-muted">
                Demo workspace · Company handbook
              </span>
            </div>
            <Image
              src="/noema-editor.png"
              width={1440}
              height={900}
              priority
              sizes="(min-width: 1024px) 560px, 100vw"
              alt="Noema's block editor showing a company handbook with a callout and a table of contents."
              className="block h-auto w-full"
            />
          </figure>
        </div>
      </section>

      <section className="relative border-y border-border bg-sidebar/70">
        <div className="mx-auto max-w-6xl px-6 py-14 lg:py-20">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                One workspace, not five tools
              </p>
              <h2 className="mt-2 max-w-2xl text-balance text-3xl font-semibold tracking-title">
                The pieces you expect, connected by one page model.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-muted">
              No separate wiki, database, project tracker and AI sidecar. They
              all read from the same pages, permissions and history.
            </p>
          </div>

          <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <article
                key={title}
                className="rounded-md border border-border bg-bg p-5 shadow-1"
              >
                <span className="grid size-9 place-items-center rounded-md bg-surface text-fg">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-4 text-sm font-semibold tracking-heading">
                  {title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">
                  {body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="relative mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-14 sm:flex-row sm:items-center lg:py-20">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-success-soft text-success">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold">Bring your own infrastructure</p>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
              Postgres, local storage and optional AI providers are configured
              by you. Noema does not require a hosted account to start.
            </p>
          </div>
        </div>
        <Button size="lg" asChild>
          <Link href="/signup">
            Start locally
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </section>

      <footer className="relative border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            MIT licensed · Built by {projectAuthorLine()} · Next.js, Prisma and
            PostgreSQL.
          </p>
          <div className="flex items-center gap-4">
            <a
              href={PROJECT_REPOSITORY}
              target="_blank"
              rel="noreferrer noopener"
              className="focus-ring rounded-sm hover:text-fg"
            >
              Source
            </a>
            <Link href="/login" className="focus-ring rounded-sm hover:text-fg">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
