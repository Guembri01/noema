"use client";

import Link from "next/link";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chatModelLabel, chatModelNote, type ChatModelInfo } from "@/lib/chat-model";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Which model answers the next question, chosen where the question is asked.
 *
 * The composer used to print the effective model as a read-only tag: the only way
 * to change it was Settings → AI, which is not where anyone looks while writing a
 * prompt. The tag is now the control.
 *
 * It is deliberately a *conversation* control rather than a settings form: it
 * needs no permission check and writes nothing to the database, so it works the
 * same for a member as for an admin, and the same whether the deployment or the
 * workspace supplied the provider. What it cannot do is change *where* the call
 * goes — see `chatModelOverride` in `src/lib/chat-model.ts`.
 */
export function ChatModelPicker({
  slug,
  info,
  model,
  onSelect,
  locale,
}: {
  slug: string;
  info: ChatModelInfo;
  /** The model the next question will use: the choice, else the configured one. */
  model: string;
  onSelect: (model: string) => void;
  locale: string;
}) {
  const note = chatModelNote(info);
  const selectable = info.options.length > 0;
  const label = chatModelLabel(info.provider, model) || model || t(locale, "aiModel");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The visible text is the model's label; naming the control as the model
          // itself would announce "DeepSeek Flash" with no role context.
          aria-label={`${t(locale, "modelLabel")}: ${label}`}
          data-testid="chat-model-trigger"
          className={cn(
            "focus-ring u-interactive flex h-6 max-w-40 min-w-0 items-center gap-1.5 rounded-control border border-border px-1.5 text-2xs text-muted hover:bg-surface-2 hover:text-fg",
          )}
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="max-w-72">
        <DropdownMenuLabel className="truncate">
          {info.providerLabel || t(locale, "aiProvider")}
        </DropdownMenuLabel>

        {info.options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.id}
            checked={option.id === model}
            disabled={!selectable}
            // Radix closes a menu on select; this one stays open so the tick lands
            // where the user can see it, next to the other choices.
            onSelect={(event) => {
              event.preventDefault();
              if (selectable) onSelect(option.id);
            }}
          >
            <span className="truncate">{option.label}</span>
          </DropdownMenuCheckboxItem>
        ))}

        {note ? <p className="px-2 py-1.5 text-2xs text-muted">{t(locale, note)}</p> : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/w/${slug}/settings`}>
            <SlidersHorizontal className="h-4 w-4 text-muted" aria-hidden />
            {t(locale, "chatModelSettings")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
