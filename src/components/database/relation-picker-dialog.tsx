"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { guarded } from "@/lib/actions-client";
import { searchRelationTargetsAction as rawSearchRelationTargetsAction } from "@/server/actions/database";
import { toggleRelation } from "@/lib/relation-picker";
import { t } from "@/lib/i18n";

const searchRelationTargetsAction = guarded(rawSearchRelationTargetsAction);

type Target = { id: string; title: string; icon: string | null };

/**
 * Cursor-paginated relation picker.
 *
 * Loaded on demand by `RelationCell` so the dialog and the server-action client
 * stay out of the database route's initial bundle. Search is debounced; a
 * "load more" request appends the next id-ordered page. Selection is applied
 * through the same `toggleRelation` engine as every other relation surface, so
 * single-cardinality replacement and self-exclusion cannot drift here.
 */
export function RelationPickerDialog({
  propertyId,
  propertyName,
  locale,
  multi,
  selectedIds,
  rowId,
  onChange,
  onClose,
}: {
  propertyId: string;
  propertyName: string;
  locale: string;
  multi: boolean;
  selectedIds: readonly string[];
  rowId?: string;
  onChange: (value: { pageIds: string[] }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Target[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<string[]>([...selectedIds]);
  const request = useRef(0);

  const load = useCallback(
    async (search: string, cursor: string | null, append: boolean) => {
      const token = request.current + 1;
      request.current = token;
      if (!append) setLoading(true);
      const result = await searchRelationTargetsAction(propertyId, search, cursor);
      if (request.current !== token) return;
      setLoading(false);
      if ("error" in result) {
        setError(result.error);
        if (!append) {
          setItems([]);
          setNextCursor(null);
        }
        return;
      }
      setError(null);
      setItems((previous) => {
        const next = append ? [...previous, ...result.items] : result.items;
        const seen = new Set<string>();
        return next.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      });
      setNextCursor(result.nextCursor);
      if (!append) setActive(0);
    },
    [propertyId],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      void load(query, null, false);
    }, 180);
    return () => clearTimeout(timer);
  }, [load, query]);

  const visible = items.filter((item) => item.id !== rowId);
  const pick = (id: string) => {
    const next = toggleRelation(picked, id, { allowMultiple: multi });
    setPicked(next);
    onChange({ pageIds: next });
    if (!multi) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="w-[min(32rem,calc(100vw-2rem))] p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold text-fg">
            {propertyName || t(locale, "addRelationAria")}
          </h2>
          <input
            autoFocus
            value={query}
            aria-label={t(locale, "search")}
            placeholder={t(locale, "search")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, visible.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter" && visible[active]) {
                event.preventDefault();
                pick(visible[active].id);
              }
            }}
            className="focus-ring mt-2 w-full rounded-control border border-border-control bg-bg px-2 py-1.5 text-sm outline-none"
          />
        </div>

        <div
          role="listbox"
          aria-multiselectable={multi}
          className="max-h-72 overflow-y-auto p-1"
        >
          {loading && visible.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted">{t(locale, "search")}…</p>
          ) : error ? (
            <p role="alert" className="px-3 py-4 text-sm text-danger">
              {error}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted">{t(locale, "noRelatedRows")}</p>
          ) : (
            visible.map((item, index) => {
              const selected = picked.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-active={index === active ? "true" : undefined}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(item.id)}
                  className="focus-ring flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm hover:bg-surface-2 data-[active=true]:bg-surface-2"
                >
                  <span aria-hidden>{item.icon ?? "📄"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {item.title || t(locale, "untitled")}
                  </span>
                  {selected ? <span aria-hidden>✓</span> : null}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            className="focus-ring rounded-control px-2 py-1 text-xs text-muted hover:bg-surface-2"
            onClick={() => {
              setPicked([]);
              onChange({ pageIds: [] });
            }}
          >
            {t(locale, "clear")}
          </button>
          <div className="flex items-center gap-1">
            {nextCursor ? (
              <button
                type="button"
                disabled={loading}
                className="focus-ring rounded-control px-2 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50"
                onClick={() => void load(query, nextCursor, true)}
              >
                {t(locale, "loadMore")}
              </button>
            ) : null}
            <button
              type="button"
              className="focus-ring rounded-control bg-action px-3 py-1 text-xs font-medium text-action-fg"
              onClick={onClose}
            >
              {t(locale, "done")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
