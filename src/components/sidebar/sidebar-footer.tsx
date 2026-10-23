"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, HelpCircle, LogOut, Search, Settings, Trash2 } from "lucide-react";
import { LOCALES, t } from "@/lib/i18n";
import { logoutAction } from "@/server/actions/auth";
import { setLocaleAction } from "@/server/actions/preferences";
import { initials, avatarColor } from "@/lib/utils";
import { toast } from "sonner";
import { safeAction } from "@/lib/actions-client";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type StartTransition = (callback: () => void) => void;

type SidebarFooterProps = {
  locale: string;
  user: { name: string; email: string };
  workspace: { slug: string };
  onOpenQuickFind: () => void;
  /** Platform-aware chord for Quick find, from `@/lib/keyboard-shortcuts`. */
  quickFindHint: string;
  startTransition: StartTransition;
};

export function SidebarFooter({
  locale,
  user,
  workspace,
  onOpenQuickFind,
  quickFindHint,
  startTransition,
}: SidebarFooterProps) {
  const router = useRouter();
  return (
    <>
    <div className="border-t border-border px-3 pt-3">
      <label className="sr-only" htmlFor="locale">
        {t(locale, "language")}
      </label>
      <select
        id="locale"
        value={locale}
        onChange={(event) =>
          startTransition(async () => {
            const outcome = await safeAction(() => setLocaleAction(event.target.value));
            if (!outcome.ok) toast.error(outcome.error);
            router.refresh();
          })
        }
        className="mb-2 h-8 w-full rounded-control border-control bg-bg px-2 text-xs text-muted outline-none"
      >
        {LOCALES.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
    <div className="flex items-center gap-2 border-t border-border p-3">
      <span
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-medium text-white"
        style={{ backgroundColor: avatarColor(user.email) }}
      >
        {initials(user.name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{user.name}</p>
        <p className="truncate text-xs text-muted">{user.email}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t(locale, "help")}
            className="focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-surface-2"
          >
            <HelpCircle className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onOpenQuickFind}>
            <Search className="h-4 w-4 text-muted" /> {t(locale, "quickFind")}
            <Kbd>{quickFindHint || "Ctrl+P"}</Kbd>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/w/${workspace.slug}/library`}>
              <BookOpen className="h-4 w-4 text-muted" /> {t(locale, "library")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/w/${workspace.slug}/trash`}>
              <Trash2 className="h-4 w-4 text-muted" /> {t(locale, "trash")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={`/w/${workspace.slug}/settings`}>
              <Settings className="h-4 w-4 text-muted" /> {t(locale, "settings")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip label={t(locale, "signOut")}>
        <form action={logoutAction}>
          <button
            type="submit"
            aria-label={t(locale, "signOut")}
            className="focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-surface-2"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </form>
      </Tooltip>
    </div>
    </>
  );
}
