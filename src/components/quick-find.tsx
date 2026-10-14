"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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


export function QuickFind({
  open,
  onOpenChange,
  workspaceId,
  workspaceSlug,
  locale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceSlug: string;
  locale: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<QuickFindResult[]>([]);
  const [loading, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setItems([]);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0">
        <Command
          shouldFilter={false}
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
              value="__new_page__"
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
              {items.map((item) => (
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
                    <span className="block truncate font-medium">
                      {item.title}
                    </span>
                    {item.snippet && (
                      <span className="block truncate text-xs text-muted">
                        {item.snippet}
                      </span>
                    )}
                  </span>
                  <FileText className="mt-0.5 h-3.5 w-3.5 text-muted" />
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
