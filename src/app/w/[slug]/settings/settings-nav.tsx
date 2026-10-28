"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The one settings navigation.
 *
 * Every settings screen renders the same nav so the section list, ordering and
 * rhythm never drift (docs/DESIGN_SYSTEM.md §4). The active section is marked
 * with `aria-current="page"` (docs/TEST_PLAN.md C9), which is why this is a
 * client component: it reads the live pathname.
 *
 * It lists the sections every member of a workspace can open. The manager-only
 * audit log is linked from the Activity block on the settings index instead, so
 * the nav never advertises a surface a non-manager would 404 on.
 *
 * The item list and the active test are pure functions so the mapping can be
 * unit-tested without a browser.
 */

export type SettingsGroup = "Workspace" | "Content" | "Account & privacy" | "Developers";

export type SettingsNavItem = {
  href: string;
  label: string;
  description: string;
  /** True for the settings index, whose href prefixes every other section. */
  exact: boolean;
  /** Logical section heading shown in the wide desktop grid. */
  group: SettingsGroup;
};

/** Canonical path for the settings index (`/w/[slug]/settings`). */
export function settingsPath(slug: string): string {
  return `/w/${slug}/settings`;
}

/** Canonical path for one settings section. */
export function settingsSectionPath(slug: string, section: string): string {
  return `${settingsPath(slug)}/${section}`;
}

/** Whether `pathname` is inside `href`; `exact` pins the index to itself. */
export function isActiveSettingsPath(
  pathname: string,
  href: string,
  exact = false,
): boolean {
  if (!href) return false;
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** The sections of settings every member can reach, in render order. */
export function settingsNavItems(slug: string, locale: string): SettingsNavItem[] {
  return [
    {
      href: settingsPath(slug),
      label: t(locale, "general"),
      description: "This workspace's name, icon and your role.",
      exact: true,
      group: "Workspace",
    },
    {
      href: settingsSectionPath(slug, "billing"),
      label: "Plan & billing",
      description: "The current plan, its limits and an upgrade preview.",
      exact: false,
      group: "Workspace",
    },
    {
      href: settingsSectionPath(slug, "move"),
      label: "Move pages",
      description: "Move a page subtree into another workspace.",
      exact: false,
      group: "Workspace",
    },
    {
      href: settingsSectionPath(slug, "prompts"),
      label: "Prompt library",
      description: "Reusable prompts with {{variable}} placeholders.",
      exact: false,
      group: "Content",
    },
    {
      href: settingsSectionPath(slug, "import"),
      label: "Import",
      description: "Bring in Notion, CSV, Markdown, Trello and more.",
      exact: false,
      group: "Content",
    },
    {
      href: settingsSectionPath(slug, "notifications"),
      label: t(locale, "notifications"),
      description: "Choose which events reach you and how they are batched.",
      exact: false,
      group: "Account & privacy",
    },
    {
      href: settingsSectionPath(slug, "data"),
      label: "Data & privacy",
      description: "Export or erase your personal data (GDPR).",
      exact: false,
      group: "Account & privacy",
    },
    {
      href: settingsSectionPath(slug, "tokens"),
      label: t(locale, "apiTokens"),
      description: "Create and revoke scoped REST API tokens.",
      exact: false,
      group: "Developers",
    },
  ];
}

export function SettingsNav({
  slug,
  locale,
  className,
}: {
  slug: string;
  locale: string;
  className?: string;
}) {
  const pathname = usePathname();
  const items = settingsNavItems(slug, locale);

  return (
    <nav
      aria-label={t(locale, "settings")}
      data-testid="settings-nav"
      className={cn(
        // Below the wide desktop the seven description cards push the actual
        // settings form an entire screen down. Use a compact, scrollable
        // section switcher there; the two-column cards return at `xl`.
        "flex gap-2 overflow-x-auto pb-1 no-scrollbar xl:grid xl:grid-cols-2 xl:gap-2 xl:overflow-visible xl:pb-0",
        className,
      )}
    >
      {items.map((item, index) => {
        const active = isActiveSettingsPath(pathname, item.href, item.exact);
        const startsGroup = index === 0 || items[index - 1]?.group !== item.group;
        return (
          <span key={item.href} className="contents">
            {startsGroup && (
              <span className="hidden xl:col-span-2 xl:mt-3 xl:first:mt-0 xl:block xl:text-2xs xl:font-semibold xl:uppercase xl:tracking-wide xl:text-muted">
                {item.group}
              </span>
            )}
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs u-colors focus-ring hover:bg-surface-2",
                "xl:whitespace-normal xl:rounded-lg xl:px-4 xl:py-3 xl:text-sm",
                // Start the strip on the current section below the wide desktop,
                // so a deep link does not open with its active item off-screen.
                active && "order-first xl:order-none",
                active
                  ? "border-border-strong bg-surface-2 text-fg"
                  : "border-border text-fg",
              )}
            >
              {item.label}
              <span className="mt-0.5 hidden text-xs text-muted xl:block">
                {item.description}
              </span>
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
