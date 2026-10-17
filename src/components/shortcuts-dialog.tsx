"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { DEFAULT_SHORTCUTS, formatCombo } from "@/lib/keyboard-shortcuts";
import { t } from "@/lib/i18n";

/**
 * Every chord the app answers to, grouped by where it works.
 *
 * The catalogue is `DEFAULT_SHORTCUTS` — the same list the key handler and the
 * command palette read, so this dialog cannot drift from what actually fires.
 * Combos are rendered through `formatCombo`, which turns the platform-agnostic
 * `Mod+K` into `⌘K` on macOS and `Ctrl+K` everywhere else.
 *
 * `isMac` starts false and is set in an effect: reading `navigator` during the
 * first render would produce different markup on the server and the client, and
 * React would report a hydration mismatch. False is the safe first paint — the
 * glyphs settle before anyone can read them.
 */
export function ShortcutsDialog({
  open,
  onClose,
  locale = "en",
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}) {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.userAgent));
  }, []);

  const global = DEFAULT_SHORTCUTS.filter((entry) => entry.scope === "global");
  const editor = DEFAULT_SHORTCUTS.filter((entry) => entry.scope === "editor");

  const section = (title: string, entries: typeof global) => (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </h3>
      <ul className="mt-2 divide-y divide-border">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-4 py-1.5">
            <span className="text-sm">{entry.label}</span>
            <Kbd keys={formatCombo(entry.combo, { isMac }).split(" ")} />
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        className="w-full max-w-md rounded-xl border border-border bg-bg p-4 shadow-2xl"
        aria-label={t(locale, "keyboardShortcuts")}
      >
        <h2 className="text-base font-semibold">{t(locale, "keyboardShortcuts")}</h2>
        <div className="mt-4 space-y-5">
          {section(t(locale, "globalShortcuts"), global)}
          {section(t(locale, "editorShortcuts"), editor)}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring u-interactive h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "close")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
