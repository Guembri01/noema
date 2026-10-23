"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronsUpDown, Download, Plus, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { ThemeToggle } from "@/components/theme-toggle";
import type { TagHue } from "@/lib/design-tokens";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ------------------------------------------------------------------------- *
 * Pure mappings — workspace row ordering, role tags and the search gate. Kept
 * DOM-free so the node tests can pin them (docs/DESIGN_SYSTEM.md §10).
 * ------------------------------------------------------------------------- */

/** A workspace as the switcher sees it. `role` is optional. */
export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  role?: string | null;
};

export type WorkspaceRoleKey = "owner" | "admin" | "member" | "guest";

const WORKSPACE_ROLE_KEYS: readonly WorkspaceRoleKey[] = [
  "owner",
  "admin",
  "member",
  "guest",
];

/** Type guard for a role key coming from persisted data. */
export function isWorkspaceRoleKey(value: unknown): value is WorkspaceRoleKey {
  return (
    typeof value === "string" &&
    (WORKSPACE_ROLE_KEYS as readonly string[]).includes(value)
  );
}

/** Normalize a persisted (`OWNER`) or engine (`owner`) role to its key. */
export function workspaceRoleKey(role: unknown): WorkspaceRoleKey | null {
  if (typeof role !== "string") return null;
  const lower = role.trim().toLowerCase();
  return isWorkspaceRoleKey(lower) ? lower : null;
}

/** Tag hue for a role, so the palette reads consistently across the app. */
export const WORKSPACE_ROLE_HUE: Record<WorkspaceRoleKey, TagHue> = {
  owner: "purple",
  admin: "blue",
  member: "green",
  guest: "gray",
};

/** A workspace row, resolved for rendering. */
export type WorkspaceRowView = WorkspaceSummary & {
  current: boolean;
  label: string;
  roleKey: WorkspaceRoleKey | null;
};

/** A workspace's display label: its trimmed name, falling back to its slug. */
export function workspaceLabel(name: string | null | undefined, slug: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed) return trimmed;
  const slugText = typeof slug === "string" ? slug.trim() : "";
  return slugText || "Workspace";
}

/** Above this many workspaces the menu grows a search field. */
export const WORKSPACE_SEARCH_THRESHOLD = 5;

/** Whether the switcher should render its search field for `count` workspaces. */
export function shouldShowWorkspaceSearch(count: number): boolean {
  return Number.isFinite(count) && count > WORKSPACE_SEARCH_THRESHOLD;
}

/**
 * Order the workspaces for the menu: the current one first, then the rest in
 * their input order. Keyless rows are dropped and duplicates collapse by slug,
 * keeping the first occurrence — so a stale copy of the current workspace can
 * never render twice.
 */
export function workspaceRows(
  currentSlug: string,
  workspaces: readonly WorkspaceSummary[],
): WorkspaceRowView[] {
  const seen = new Set<string>();
  const rows: WorkspaceRowView[] = [];
  const push = (workspace: WorkspaceSummary, current: boolean) => {
    const slug = typeof workspace?.slug === "string" ? workspace.slug : "";
    if (!workspace || !slug || seen.has(slug)) return;
    seen.add(slug);
    rows.push({
      ...workspace,
      current,
      label: workspaceLabel(workspace.name, slug),
      roleKey: workspaceRoleKey(workspace.role),
    });
  };
  const current = workspaces.find((workspace) => workspace?.slug === currentSlug);
  if (current) push(current, true);
  for (const workspace of workspaces) push(workspace, workspace?.slug === currentSlug);
  return rows;
}

/** Case-insensitive filter over a row's label and slug. */
export function filterWorkspaces(
  rows: readonly WorkspaceRowView[],
  query: string,
): WorkspaceRowView[] {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.label.toLowerCase().includes(needle) ||
      row.slug.toLowerCase().includes(needle),
  );
}

/** Literal label for the "you are here" badge — see the i18n follow-up note. */
export const CURRENT_WORKSPACE_LABEL = "Current workspace";

/* ------------------------------------------------------------------------- *
 * Glyph
 * ------------------------------------------------------------------------- */

/**
 * A workspace's leading glyph: its emoji when it has one, otherwise a
 * deterministic initials `Avatar`.
 */
function WorkspaceGlyph({
  workspace,
  size = 24,
}: {
  workspace: { name: string; slug: string; icon: string | null };
  size?: number;
}) {
  if (workspace.icon) {
    return (
      <span
        aria-hidden
        className="grid shrink-0 place-items-center rounded-control bg-surface-2"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
      >
        {workspace.icon}
      </span>
    );
  }
  return <Avatar size={size} user={{ id: workspace.slug, name: workspace.name }} />;
}

/* ------------------------------------------------------------------------- *
 * Menu body (presentational + search state; rendered inside the dropdown)
 * ------------------------------------------------------------------------- */

export type WorkspaceSwitcherMenuProps = {
  workspace: { name: string; slug: string; icon: string | null; role: string };
  workspaces: WorkspaceSummary[];
  user: { email: string };
  locale: string;
  onCreateWorkspace: () => void;
};

/**
 * The switcher's dropdown body: account header, workspace list (with role tags
 * and the current-workspace badge), an optional search field, and the create /
 * settings / export entries. Split out so `renderToStaticMarkup` can pin it.
 */
export function WorkspaceSwitcherMenu({
  workspace,
  workspaces,
  user,
  locale,
  onCreateWorkspace,
}: WorkspaceSwitcherMenuProps) {
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => workspaceRows(workspace.slug, workspaces),
    [workspace.slug, workspaces],
  );
  const visible = useMemo(() => filterWorkspaces(rows, query), [rows, query]);
  const showSearch = shouldShowWorkspaceSearch(rows.length);
  const currentRoleKey = workspaceRoleKey(workspace.role);

  const stopMenuKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    // The search field owns its keystrokes (otherwise Radix would treat typing
    // as menu type-ahead and move/select the highlight). Escape and Tab still
    // bubble, so the menu can be dismissed and focus can leave.
    if (event.key === "Escape" || event.key === "Tab") return;
    event.stopPropagation();
  };

  return (
    <>
      <div className="px-2 py-1.5 text-xs text-muted">
        <p className="truncate" title={user.email}>
          {user.email}
        </p>
        {currentRoleKey ? (
          <Tag
            hue={WORKSPACE_ROLE_HUE[currentRoleKey]}
            size="sm"
            className="mt-1"
          >
            {t(locale, currentRoleKey)}
          </Tag>
        ) : null}
      </div>

      <DropdownMenuSeparator />

      <DropdownMenuLabel>{t(locale, "workspaces")}</DropdownMenuLabel>

      {showSearch ? (
        <div className="px-1 pb-1">
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={stopMenuKeys}
            aria-label={t(locale, "search")}
            placeholder={t(locale, "search")}
            leading={<Search className="h-3.5 w-3.5" />}
            clearable
            onClear={() => setQuery("")}
          />
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          variant="compact"
          title={t(locale, "noResults")}
          description={t(locale, "noResultsDot")}
          className="py-4"
        />
      ) : (
        visible.map((row) => {
          const glyph = row.icon ? (
            <span aria-hidden className="w-5 shrink-0 text-center text-sm">
              {row.icon}
            </span>
          ) : (
            <Avatar size={20} user={{ id: row.slug, name: row.name }} />
          );
          return (
            <DropdownMenuItem key={row.id} asChild>
              <Link
                href={`/w/${row.slug}`}
                aria-current={row.current ? "page" : undefined}
                title={row.label}
              >
                {glyph}
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.roleKey ? (
                  <Tag hue={WORKSPACE_ROLE_HUE[row.roleKey]} size="sm">
                    {t(locale, row.roleKey)}
                  </Tag>
                ) : null}
                {row.current ? (
                  <Badge
                    tone="accent"
                    size="sm"
                    icon={<Check className="h-3 w-3" />}
                    aria-label={CURRENT_WORKSPACE_LABEL}
                    title={CURRENT_WORKSPACE_LABEL}
                  />
                ) : null}
              </Link>
            </DropdownMenuItem>
          );
        })
      )}

      <DropdownMenuSeparator />

      <DropdownMenuItem onSelect={onCreateWorkspace}>
        <Plus className="h-4 w-4 text-muted" aria-hidden />
        {t(locale, "newWorkspace")}
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href={`/w/${workspace.slug}/settings`}>
          <Settings className="h-4 w-4 text-muted" aria-hidden />
          {t(locale, "workspaceSettings")}
        </Link>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem asChild>
        <Link href="/app">
          <Settings className="h-4 w-4 text-muted" aria-hidden />
          {t(locale, "allWorkspaces")}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={`/api/export/workspace/${workspace.slug}`} download>
          <Download className="h-4 w-4 text-muted" aria-hidden />
          {t(locale, "exportWorkspace")}
        </a>
      </DropdownMenuItem>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Switcher
 * ------------------------------------------------------------------------- */

type WorkspaceSwitcherProps = {
  workspace: { name: string; slug: string; icon: string | null; role: string };
  workspaces: WorkspaceSummary[];
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
          <button
            type="button"
            aria-label={workspace.name}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-control px-1 py-1 text-fg",
              "u-interactive u-colors focus-ring hover:bg-surface-2",
            )}
          >
            <WorkspaceGlyph workspace={workspace} />
            <span className="truncate text-sm font-semibold">{workspace.name}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[260px]">
          <WorkspaceSwitcherMenu
            workspace={workspace}
            workspaces={workspaces}
            user={user}
            locale={locale}
            onCreateWorkspace={onCreateWorkspace}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ThemeToggle locale={locale} />
    </div>
  );
}
