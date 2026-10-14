"use client";

import Link from "next/link";
import { Check, Download, Plus, Settings } from "lucide-react";
import { initials } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type WorkspaceSwitcherProps = {
  workspace: { name: string; slug: string; icon: string | null; role: string };
  workspaces: { id: string; name: string; slug: string; icon: string | null }[];
  user: { email: string };
  locale: string;
  onCreateWorkspace: () => void;
};

export function WorkspaceSwitcher({
  workspace,
  workspaces,
  user,
  locale,
  onCreateWorkspace,
}: WorkspaceSwitcherProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex min-w-0 items-center gap-2 rounded px-1 py-1 hover:bg-surface-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-bg text-xs">
              {workspace.icon ?? initials(workspace.name)}
            </span>
            <span className="truncate text-sm font-semibold">
              {workspace.name}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[240px]">
          <p className="px-2 py-1.5 text-xs text-muted">
            {user.email}
            <span className="ml-1.5 rounded bg-surface px-1.5 py-0.5 text-[10px]">
              {workspace.role.toLowerCase()}
            </span>
          </p>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-2 py-1 text-[11px] text-muted">
            {t(locale, "workspaces")}
          </DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem key={w.id} asChild>
              <Link
                href={`/w/${w.slug}`}
                aria-current={w.slug === workspace.slug ? "page" : undefined}
              >
                <span className="w-4 text-center text-xs">{w.icon ?? initials(w.name)}</span>
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.slug === workspace.slug && <Check className="h-3.5 w-3.5 text-accent" />}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={onCreateWorkspace}>
            <Plus className="h-4 w-4 text-muted" /> {t(locale, "newWorkspace")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/app">
              <Settings className="h-4 w-4 text-muted" /> {t(locale, "allWorkspaces")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/w/${workspace.slug}/settings`}>
              <Settings className="h-4 w-4 text-muted" /> {t(locale, "settings")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/api/export/workspace/${workspace.slug}`} download>
              <Download className="h-4 w-4 text-muted" /> {t(locale, "exportWorkspace")}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ThemeToggle locale={locale} />
    </div>
  );
}
