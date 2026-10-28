"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { searchHref } from "@/lib/live-search";
import { t } from "@/lib/i18n";

const DEBOUNCE_MS = 220;

/**
 * Live search box for the workspace search page.
 *
 * The route stays a server component (it owns the FTS query and guest scope);
 * this input only updates the URL after a short pause, which makes the results
 * stream in as the user types instead of requiring Enter.
 */
export function LiveSearchInput({
  initialQuery,
  type,
  locale,
}: {
  initialQuery: string;
  type?: string | null;
  locale: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(initialQuery);
  const [pending, startTransition] = useTransition();
  const lastHref = useRef<string | null>(
    searchHref(pathname, initialQuery, type),
  );

  useEffect(() => {
    const href = searchHref(pathname, value, type);
    if (lastHref.current === href) return;
    const timer = window.setTimeout(() => {
      lastHref.current = href;
      startTransition(() => router.replace(href, { scroll: false }));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [pathname, router, type, value]);

  return (
    <form
      method="GET"
      className="relative"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(() =>
          router.replace(searchHref(pathname, value, type), { scroll: false }),
        );
      }}
    >
      {type ? <input type="hidden" name="type" value={type} /> : null}
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoFocus
        aria-busy={pending || undefined}
        placeholder={t(locale, "searchTitlesAndContent")}
        className="focus-ring h-11 w-full rounded-control border border-border bg-bg pl-9 pr-9 text-sm outline-none"
        data-testid="workspace-search-input"
      />
      {pending ? (
        <span
          className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-border border-t-action"
          aria-label="Searching"
        />
      ) : null}
    </form>
  );
}
