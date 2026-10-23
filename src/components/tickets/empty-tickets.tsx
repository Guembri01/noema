"use client";

import { Plus, Tag, Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { t } from "@/lib/i18n";

/**
 * Shown in place of the list/board/timeline when the workspace holds no tickets
 * at all.
 *
 * ds08: rebuilt on the shared `EmptyState` primitive (docs/DESIGN_SYSTEM.md §8
 * "empty") so it matches every other zero-state surface — icon + title + hint +
 * a primary/secondary action — instead of the hand-rolled dashed box. Both CTAs
 * are the design-system `Button` (token colours, `.focus-ring`, `.u-interactive`,
 * all seven states) and the block fades in with the named `animate-fade` token.
 */
export function EmptyTicketsState({
  onCreate,
  onAddLabel,
  hasLabels,
  locale = "en",
}: {
  onCreate: () => void;
  onAddLabel: () => void;
  /** Whether the workspace already has labels (changes the second CTA copy). */
  hasLabels: boolean;
  locale?: string;
}) {
  return (
    <div
      data-testid="tickets-empty"
      className="animate-fade rounded-lg border border-dashed border-border"
    >
      <EmptyState
        variant="full"
        icon={<Ticket className="h-5 w-5" aria-hidden />}
        title={t(locale, "noTicketsYet")}
        description="Create your first ticket to start tracking work, or add a label to organise everything that follows."
        primaryAction={
          <Button
            variant="primary"
            size="md"
            leftIcon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={onCreate}
          >
            {t(locale, "createTicket")}
          </Button>
        }
        secondaryAction={
          <Button
            variant="secondary"
            tone="soft"
            size="md"
            leftIcon={<Tag className="h-4 w-4" aria-hidden />}
            onClick={onAddLabel}
          >
            {hasLabels ? "Add another label" : "Add a label"}
          </Button>
        }
      />
    </div>
  );
}
