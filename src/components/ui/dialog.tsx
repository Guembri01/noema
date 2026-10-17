"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import { overlayMotionClasses } from "@/components/ui/dropdown-menu";
import { FloatingHostProvider } from "@/components/ui/floating-layer";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Modal dialog content.
 *
 * Focus contract (FEATURE_MATRIX row "Focus management", verified by
 * `e2e/focus.spec.ts`):
 *  - trap: Tab/Shift+Tab cycle INSIDE the dialog (Radix `FocusScope` loop),
 *  - Escape closes,  initial focus lands on the first tabbable stop,
 *  - focus RETURNS TO THE INVOKER on close (see below),
 *  - `aria-modal="true"`: Radix deliberately omits it (it aria-hides the rest
 *    of the page via `hideOthers()` instead), so the primitive declares it.
 *    `{...props}` spreads last, so a consumer may still override it.
 *
 * Focus return: Radix's *modal* `onCloseAutoFocus` default does
 * `event.preventDefault(); context.triggerRef.current?.focus()` - and
 * `triggerRef` is null for every controlled dialog in this app (ShareDialog,
 * QuickFind, workspace / Notion-import / prompt dialogs open from external
 * state with no `<DialogTrigger>`), so focus used to fall to `<body>`.
 * The primitive therefore records the element that held focus when the dialog
 * opened and restores it itself; consumers keep the usual Radix semantics
 * (their `onCloseAutoFocus` runs first and may `preventDefault()` to take
 * over, their `onOpenAutoFocus` may still prevent the initial focus move).
 *
 * Motion: the surface scales in (`animate-scale-in`, `--dur-2`) and mirrors
 * out (`--dur-1`); the scrim fades between `Z.overlay` and `Z.modal`. The
 * surface is centred with `inset-x-0 mx-auto` (not a translate) so the enter
 * transform never fights the layout.
 */
export function DialogContent({
  className,
  style,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const invokerRef = React.useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Portal>
      <FloatingHostProvider>
        <DialogPrimitive.Overlay
          className={cn("fixed inset-0 bg-overlay", overlayMotionClasses("scrim"))}
          style={{ zIndex: Z.overlay }}
        />
        <DialogPrimitive.Content
          role="dialog"
          aria-modal="true"
          className={cn(
            "surface-raised-strong fixed inset-x-0 top-[15%] mx-auto w-full max-w-xl",
            overlayMotionClasses("dialog"),
            className,
          )}
          style={{ zIndex: Z.modal, ...style }}
          onOpenAutoFocus={(event) => {
            // FocusScope dispatches this synchronously BEFORE moving focus into
            // the dialog, so activeElement is still the invoking control.
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body) {
              invokerRef.current = active;
            }
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return; // consumer took over
            const invoker = invokerRef.current;
            invokerRef.current = null;
            if (invoker?.isConnected) {
              // Skip Radix's trigger fallback (null without <DialogTrigger>) and
              // FocusScope's own return - we restore focus ourselves.
              event.preventDefault();
              invoker.focus();
            }
            // No recorded invoker (focus was already inside the dialog): defer to
            // Radix so a <DialogTrigger>-based dialog still restores its trigger.
          }}
          {...props}
        >
          {children}
        </DialogPrimitive.Content>
      </FloatingHostProvider>
    </DialogPrimitive.Portal>
  );
}
