"use client";

import { useState } from "react";
import { Ellipsis } from "lucide-react";
import { ViewSettings } from "@/components/database/view-settings";
import type { ColumnLayout } from "@/lib/column-layout";
import type { DBProperty } from "@/components/database/database-types";
import type { ViewConfig } from "@/lib/database-query";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * The database's view-control composition: five common controls inline, the
 * advanced controls behind one disclosure. The screen owns neither the open
 * state nor the placement anymore.
 */
export function DatabaseViewToolbar({
  locale,
  properties,
  config,
  editable,
  onChange,
  layout,
  onLayoutChange,
}: {
  locale: string;
  properties: DBProperty[];
  config: ViewConfig;
  editable: boolean;
  onChange: (patch: Partial<ViewConfig>) => void;
  layout?: ColumnLayout;
  onLayoutChange?: (layout: ColumnLayout) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        {/* On a phone the five primary controls scroll sideways inside this
            flexible track; the “More” trigger stays pinned to the right instead
            of wrapping onto a row of its own. */}
        <div className="min-w-0 flex-1 sm:flex-none">
          <ViewSettings
            variant="primary"
            locale={locale}
            properties={properties}
            config={config}
            editable={editable}
            onChange={onChange}
            layout={layout}
            onLayoutChange={onLayoutChange}
          />
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(locale, "dbViewMenu")}
          title={t(locale, "dbViewMenu")}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "focus-ring u-colors mb-3 flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-surface-2",
            open && "bg-surface-2 text-fg",
          )}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className="mb-3 rounded-lg border border-border bg-surface p-2">
          <ViewSettings
            variant="advanced"
            locale={locale}
            properties={properties}
            config={config}
            editable={editable}
            onChange={onChange}
            layout={layout}
            onLayoutChange={onLayoutChange}
          />
        </div>
      )}
    </>
  );
}
