import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";
import { NoemaWordmark } from "@/components/brand/noema-wordmark";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main
      id="main"
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg px-6 py-16"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 start-1/2 size-96 -translate-x-1/2 rounded-full bg-accent-soft blur-3xl"
      />
      <div className="relative flex w-full max-w-md flex-col items-center text-center">
        <NoemaWordmark href="/" />
        <span className="mt-10 grid size-12 place-items-center rounded-lg border border-border bg-surface text-muted">
          <SearchX className="size-5" aria-hidden />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-heading">
          This page does not exist
        </h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
          The link may be old, or the page may have moved to another workspace.
          Your own pages are still where you left them.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link href="/">
              <ArrowLeft className="size-4" aria-hidden />
              Back to Noema
            </Link>
          </Button>
          <Button variant="secondary" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
        <p className="mt-8 text-xs text-fg-subtle">
          If you followed a shared link, ask the owner to share it again.
        </p>
      </div>
    </main>
  );
}
