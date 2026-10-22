"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initials } from "@/lib/utils";
import { tagStyle } from "@/lib/design-tokens";
import { t } from "@/lib/i18n";
import { avatarHue } from "@/components/database/database-types";

/**
 * PEOPLE cell.
 *
 * The local draft wins until the component remounts: the server echo of the
 * first pick would otherwise be stale when the second pick is made. Names are
 * de-duplicated and blanks are dropped; the deterministic avatar hue is shared
 * with every other person surface.
 */
export function PeopleCell({
  propertyName,
  value,
  editable,
  locale,
  members,
  onChange,
}: {
  propertyName: string;
  value: unknown;
  editable: boolean;
  locale: string;
  members: readonly { id: string; name: string }[];
  onChange: (value: { names: string[] }) => void;
}) {
  const record = (value ?? {}) as { names?: unknown };
  const valueNames = Array.from(
    new Set(
      (Array.isArray(record.names) ? record.names : []).filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      ),
    ),
  );
  const [draft, setDraft] = useState<string[] | null>(null);
  const names = draft ?? valueNames;
  const emit = (next: string[]) => {
    setDraft(next);
    onChange({ names: next });
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      role="group"
      aria-label={propertyName}
    >
      {names.map((name) => (
        <span
          key={name}
          className="flex min-w-0 max-w-full items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs"
        >
          <span
            aria-hidden
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-3xs font-medium"
            style={tagStyle(avatarHue(name))}
          >
            {initials(name)}
          </span>
          <span className="min-w-0 truncate" title={name}>
            {name}
          </span>
          {editable ? (
            <button
              type="button"
              aria-label={`${t(locale, "remove")}: ${name}`}
              onClick={() => emit(names.filter((entry) => entry !== name))}
              className="focus-ring shrink-0 text-muted hover:text-fg"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {editable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "addPersonAria")}
              className="focus-ring rounded px-1 text-xs text-muted hover:bg-surface-2"
            >
              +
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {members.length === 0 ? (
              <DropdownMenuItem disabled>{t(locale, "noMembersYet")}</DropdownMenuItem>
            ) : (
              members.map((member) => {
                const active = names.includes(member.name);
                return (
                  <DropdownMenuItem
                    key={member.id}
                    onSelect={() =>
                      emit(
                        active
                          ? names.filter((entry) => entry !== member.name)
                          : [...names, member.name],
                      )
                    }
                  >
                    {active ? "✓ " : ""}
                    {member.name}
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {names.length === 0 && !editable ? (
        <span className="text-muted">—</span>
      ) : null}
    </div>
  );
}
