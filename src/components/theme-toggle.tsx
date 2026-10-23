"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/i18n";

/** Theme picker: light, dark, or follow the operating system. */
export function ThemeToggle({ locale = "en" }: { locale?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <span
        aria-hidden
        className="inline-block h-8 w-8 rounded-md border border-border"
      />
    );
  }

  const isDark = resolvedTheme === "dark";
  const options = [
    { value: "light", label: t(locale, "light"), icon: Sun },
    { value: "dark", label: t(locale, "dark"), icon: Moon },
    { value: "system", label: t(locale, "system"), icon: Monitor },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t(locale, "theme")}
          className="focus-ring u-interactive inline-flex h-8 w-8 items-center justify-center rounded-control border border-border text-muted transition hover:bg-surface-2"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => {
          const Icon = option.icon;
          const active = (theme ?? "light") === option.value;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setTheme(option.value)}
            >
              <Icon className="h-4 w-4 text-muted" />
              <span className="flex-1">{option.label}</span>
              {active && <Check className="h-4 w-4" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
