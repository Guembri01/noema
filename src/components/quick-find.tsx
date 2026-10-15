"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { FileText, Loader2, Plus, Search } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  quickFindAction,
  type QuickFindResult,
} from "@/server/actions/search";
import { createPageAction } from "@/server/actions/pages";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { highlightSnippet } from "@/lib/fuzzy";
import { nextIndex, pageStepIndex, rovingTabIndex } from "@/lib/keyboard-nav";
import {
  DEFAULT_SUMMARY_LENGTH,
  extractDescription,
  summarizeBlocks,
  truncateAtWord,
  type SummaryBlock,
} from "@/lib/page-summary";

/**
 * Plain-text teaser for one quick-find row (MISSING_FEATURES §1): stored blocks
 * via `summarizeBlocks` when available, otherwise the result's snippet read as a
 * paragraph through `extractDescription` and truncated at a word boundary.
 */
function pageTeaser(
  content: { snippet?: string; blocks?: readonly SummaryBlock[] },
  maxLength: number,
): string {
  if (content.blocks && content.blocks.length > 0) {
    const summary = summarizeBlocks(content.blocks, { maxLength });
    if (summary) return summary;
  }
  const snippet = content.snippet ?? "";
  if (!snippet) return "";
  const described = extractDescription([{ type: "paragraph", text: snippet }]);
  return truncateAtWord(described ?? snippet, maxLength);
}

/** Teaser text with the active query highlighted via the shared `highlightSnippet`. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const match = highlightSnippet(text, query, text.length);
  if (!match) return <>{text}</>;
  const { text: excerpt, matchStart, matchEnd } = match;
  return (
    <>
      {excerpt.slice(0, matchStart)}
      <mark className="rounded-sm bg-accent/20 text-inherit">
        {excerpt.slice(matchStart, matchEnd)}
      </mark>
      {excerpt.slice(matchEnd)}
    </>
  );
}


/** Stable cmdk value for the always-present "create a new page" row (first). */
const NEW_PAGE_VALUE = "__new_page__";

/**
 * Quick find (B43 predecessor): a debounced server search rendered through
 * `cmdk`. Filtering is server-side (`shouldFilter={false}`), so list
 * navigation is driven explicitly here — the shared `src/lib/keyboard-nav.ts`
 * helpers (`nextIndex` for ↑↓/Home/End with wrap, `pageStepIndex` for a
 * PageUp/PageDown screenful) replace cmdk's built-in index math by owning the
 * controlled selection value.
 */
export function QuickFind({
  open,
  onOpenChange,
  workspaceId,
  workspaceSlug,
  locale,
  previewLength = DEFAULT_SUMMARY_LENGTH,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceSlug: string;
  locale: string;
  /** Longest teaser shown per result, including the trailing ellipsis. */
  previewLength?: number;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<QuickFindResult[]>([]);
  // Controlled cmdk selection: the "create" row first, then the pages.
  const [activeValue, setActiveValue] = useState<string>(NEW_PAGE_VALUE);
  const [loading, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemValues = useMemo(
    () => [NEW_PAGE_VALUE, ...items.map((item) => item.id)],
    [items],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setItems([]);
      setActiveValue(NEW_PAGE_VALUE);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      startTransition(async () => {
        const results = await quickFindAction(workspaceId, query);
        if ("error" in results) {
          toast.error(results.error);
          return;
        }
        setItems(results);
      });
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, open, workspaceId]);

  const go = (id: string) => {
    onOpenChange(false);
    router.push(`/w/${workspaceSlug}/${id}`);
  };

  const createNew = () => {
    onOpenChange(false);
    startTransition(async () => {
      const result = await createPageAction({ workspaceId, parentId: null });

      if ("ok" in result) {
        router.push(`/w/${workspaceSlug}/${result.id}`);
        router.refresh();
      }
    });
  };

  // ArrowUp/Down/Home/End (wrapping) and PageUp/PageDown (one screenful,
  // clamped) move the controlled cmdk selection through the flat row order.
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Leave IME composition alone (cmdk's own handler bails here too).
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const count = itemValues.length;
    if (count === 0) return;
    const current = rovingTabIndex(itemValues.indexOf(activeValue), count);
    const { key } = event;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      setActiveValue(itemValues[nextIndex(current, { key, count })]);
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      setActiveValue(itemValues[pageStepIndex(current, { key, count })]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0">
        <Command
          shouldFilter={false}
          value={activeValue}
          onValueChange={setActiveValue}
          onKeyDown={onListKeyDown}
          className="flex max-h-[420px] flex-col"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 text-muted" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder={t(locale, "quickFindPlaceholder")}
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          </div>
          <Command.List className="overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
              {loading ? t(locale, "searching") : t(locale, "noResultsDot")}
            </Command.Empty>

            <Command.Item
              value={NEW_PAGE_VALUE}
              onSelect={createNew}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm data-[selected=true]:bg-surface-2"
            >
              <Plus className="h-4 w-4 text-muted" />
              {t(locale, "createNewPage")}
            </Command.Item>

            <Command.Group
              heading={t(locale, "pages")}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted"
            >
              {items.map((item) => {
                const teaser = pageTeaser(item, previewLength);
                return (
                  <Command.Item
                    key={item.id}
                    value={item.id}
                    onSelect={() => go(item.id)}
                    className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-sm data-[selected=true]:bg-surface-2"
                  >
                    <span className="mt-0.5 w-4 text-center">
                      {item.icon ?? (item.type === "DATABASE" ? "🗂️" : "📄")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.title}</span>
                      {teaser && (
                        <span className="block truncate text-xs text-muted">
                          <HighlightedText text={teaser} query={query} />
                        </span>
                      )}
                    </span>
                    <FileText className="mt-0.5 h-3.5 w-3.5 text-muted" />
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
