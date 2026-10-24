"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

const COPY_FEEDBACK_MS = 1600;

/**
 * One read-only value with a copy control. Used for the SP-facing URLs (ACS,
 * metadata, entity id, SLO) an admin pastes into their IdP. The value stays in
 * the DOM as selectable text when the Clipboard API is unavailable.
 */
export function SsoCopyField({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clipboard) return;
    void clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  }, [value]);

  return (
    <div className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
          <code className="mt-1 block break-all font-mono text-xs text-fg">{value}</code>
          {description && <p className="mt-1 text-xs text-muted">{description}</p>}
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={copy}
          leftIcon={
            copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
