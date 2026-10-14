import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export default async function Home() {
  const user = await getCurrentUser();
  if (user) redirect("/app");

  const features = [
    ["Block editor", "Headings, lists, to-dos, quotes, code and more."],
    ["Databases", "Table, board and list views with typed properties."],
    ["Nested pages", "An infinitely nested page tree with favorites."],
    ["Search & history", "Full-text search, comments and page history."],
    ["Self-hosted", "Runs entirely on your machine with Postgres."],
    ["Open source", "MIT-licensed and yours to extend."],
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <span className="text-lg font-semibold tracking-tight">Noema</span>
        <nav aria-label="Primary" className="flex items-center gap-2">
          <Link href="/login">
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
          </Link>
          <Link href="/signup">
            <Button size="sm">Get started</Button>
          </Link>
        </nav>
      </header>

      <section className="flex flex-1 flex-col justify-center py-16">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          A local-first workspace for notes, docs and databases.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Noema is an open-source, self-hosted alternative for teams and
          individuals. Everything is a page — documents, folders and database
          rows share one model.
        </p>
        <div className="mt-8 flex gap-3">
          <Link href="/signup">
            <Button size="md">Create your workspace</Button>
          </Link>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-surface-2"
          >
            View source
          </a>
        </div>

        <dl className="mt-16 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(([title, body]) => (
            <div key={title}>
              <dt className="font-medium">{title}</dt>
              <dd className="mt-1 text-sm text-muted">{body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="border-t border-border py-6 text-sm text-muted">
        MIT licensed · Built with Next.js, Prisma and PostgreSQL.
      </footer>
    </main>
  );
}
