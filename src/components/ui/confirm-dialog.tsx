"use client";

/**
 * ConfirmDialog — a confirmation surface with the three guards a destructive
 * action needs (docs/DESIGN_SYSTEM.md §7 layering, §8 loading/disabled/error):
 *
 *  1. a **danger** tone sourced from `--danger` / `--danger-soft`;
 *  2. a **pending** state that disables the confirm button, shows a spinner and
 *     refuses a second submit (`confirmBlocked`);
 *  3. an optional **type-to-confirm** phrase for destructive bulk actions, plus
 *     a **non-blocking two-step** mode (arm → confirm) as an alternative to a modal.
 *
 * The modal is built on the Radix Dialog primitive (`@radix-ui/react-dialog`,
 * the same primitive `ui/dialog` wraps): focus trap, Escape and body-scroll lock
 * come from Radix, while the scrim and content carry the design-system chrome
 * (`--overlay` + `Z.overlay`, `.surface-raised-strong` + `Z.modal`). Focus is
 * returned to the invoking control exactly like `ui/dialog`.
 *
 * The two-step mode renders inline and never blocks the page: the first press
 * arms the control, the second confirms.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Info, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import { FloatingHostProvider } from "@/components/ui/floating-layer";

/* ------------------------------------------------------------------------- *
 * Pure state — two-step machine + submit gate
 * ------------------------------------------------------------------------- */

export type TwoStepState = "idle" | "armed";
export type TwoStepEvent = "press" | "cancel" | "reset";

/**
 * arm → confirm machine.
 *
 *  - `idle`  --press--> `armed`
 *  - `armed` --press--> `idle`    (the second press *is* the confirmation)
 *  - any     --cancel/reset--> `idle`
 */
export function reduceTwoStep(state: TwoStepState, event: TwoStepEvent): TwoStepState {
  if (event === "cancel" || event === "reset") return "idle";
  return state === "idle" ? "armed" : "idle";
}

/** What a press does right now: arm the control, or fire the confirmation. */
export function nextPressAction(state: TwoStepState): "arm" | "confirm" {
  return state === "armed" ? "confirm" : "arm";
}

export type ConfirmGate = {
  /** The action is in flight — never allow a second submit. */
  pending?: boolean;
  /** Two-step mode: only a confirm *after* arming is allowed. */
  armed?: boolean;
  /** Text the user has typed (type-to-confirm). */
  typed?: string;
  /** Exact phrase required before confirm enables; empty/absent = no phrase. */
  phrase?: string;
};

/** True when the confirm action must stay disabled for the given gate. */
export function confirmBlocked(gate: ConfirmGate): boolean {
  if (gate.pending) return true;
  if (gate.armed === false) return true;
  if (
    gate.phrase !== undefined &&
    gate.phrase !== "" &&
    (gate.typed ?? "") !== gate.phrase
  ) {
    return true;
  }
  return false;
}

/** The inverse of {@link confirmBlocked}: the confirm action may fire. */
export function canConfirm(gate: ConfirmGate): boolean {
  return !confirmBlocked(gate);
}

/* ------------------------------------------------------------------------- *
 * Tone
 * ------------------------------------------------------------------------- */

export type ConfirmTone = "default" | "danger";

/** Confirm-button classes per tone — colours straight from the token palette. */
export const CONFIRM_TONE_CLASS: Record<ConfirmTone, string> = {
  default: "bg-action text-action-fg hover:opacity-90",
  danger: "bg-danger text-danger-fg hover:opacity-90",
};

export function confirmToneClass(tone: ConfirmTone): string {
  return CONFIRM_TONE_CLASS[tone];
}

/** Icon-bubble classes per tone (`--danger-soft` / `--action-soft`). */
export const CONFIRM_ICON_CLASS: Record<ConfirmTone, string> = {
  default: "bg-action-soft text-action",
  danger: "bg-danger-soft text-danger",
};

const CONFIRM_BUTTON_BASE = "focus-ring u-colors inline-flex h-9 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

const CONFIRM_CANCEL_BASE = "focus-ring u-colors inline-flex h-9 items-center justify-center rounded-control border border-border bg-bg px-3 text-sm font-medium text-fg hover:bg-surface-2";

const CONFIRM_INPUT_CLASS = "mt-1 h-10 w-full rounded-control border border-control bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus-ring";

/* ------------------------------------------------------------------------- *
 * ConfirmDialog
 * ------------------------------------------------------------------------- */

export type ConfirmDialogProps = {
  /** Controlled open state. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Extra body content (e.g. a list of what will be deleted). */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Label shown by the two-step control before it is armed. Defaults to `confirmLabel`. */
  armLabel?: string;
  tone?: ConfirmTone;
  /** In-flight state: disables confirm, shows a spinner, blocks a second submit. */
  pending?: boolean;
  onConfirm: () => void;
  /** Destructive bulk gate: the user must type this exact phrase to enable confirm. */
  confirmPhrase?: string;
  typed?: string;
  onTypedChange?: (value: string) => void;
  /** Label above the type-to-confirm input. */
  typedConfirmLabel?: string;
  /** `modal` (blocking, default) or `two-step` (inline arm → confirm, non-blocking). */
  mode?: "modal" | "two-step";
  /** Two-step armed state (controlled); omit for internal state. */
  armed?: boolean;
  onArmedChange?: (armed: boolean) => void;
  className?: string;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  armLabel,
  tone = "default",
  pending = false,
  onConfirm,
  confirmPhrase,
  typed,
  onTypedChange,
  typedConfirmLabel = "Type the phrase to confirm",
  mode = "modal",
  armed,
  onArmedChange,
  className,
}: ConfirmDialogProps) {
  const invokerRef = React.useRef<HTMLElement | null>(null);

  const [internalTyped, setInternalTyped] = React.useState("");
  const typedValue = typed ?? internalTyped;
  const setTyped = onTypedChange ?? setInternalTyped;

  const [internalArmed, setInternalArmed] = React.useState(false);
  const armedValue = armed ?? internalArmed;
  const setArmed = onArmedChange ?? setInternalArmed;

  // Synchronous latch so a double click cannot fire `onConfirm` twice before the
  // `pending` prop round-trips. Reset whenever the dialog re-opens.
  const firedRef = React.useRef(false);
  React.useEffect(() => {
    if (open) firedRef.current = false;
  }, [open]);

  const gate: ConfirmGate = { pending, typed: typedValue, phrase: confirmPhrase };
  const enabled = canConfirm(gate);

  const submit = () => {
    if (firedRef.current || !enabled) return;
    firedRef.current = true;
    onConfirm();
  };

  const toneClass = confirmToneClass(tone);
  const iconClass = CONFIRM_ICON_CLASS[tone];
  const icon =
    tone === "danger" ? (
      <TriangleAlert className="h-4 w-4" aria-hidden />
    ) : (
      <Info className="h-4 w-4" aria-hidden />
    );

  const body = (
    <>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          data-testid="confirm-icon"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            iconClass,
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="text-xl font-semibold tracking-heading">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-sm text-muted">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
      </div>

      {children ? <div className="mt-4 text-sm text-fg">{children}</div> : null}

      {confirmPhrase ? (
        <label className="mt-4 block text-sm">
          <span className="text-muted">
            {typedConfirmLabel}:{" "}
            <code className="rounded-xs bg-surface-2 px-1 font-mono text-xs text-fg">
              {confirmPhrase}
            </code>
          </span>
          <input
            type="text"
            value={typedValue}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="confirm-phrase-input"
            className={CONFIRM_INPUT_CLASS}
          />
        </label>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <DialogPrimitive.Close asChild>
          <button
            type="button"
            data-testid="confirm-cancel"
            aria-label={cancelLabel}
            className={CONFIRM_CANCEL_BASE}
          >
            {cancelLabel}
          </button>
        </DialogPrimitive.Close>
        <button
          type="button"
          onClick={submit}
          disabled={!enabled}
          aria-busy={pending || undefined}
          aria-label={confirmLabel}
          data-testid="confirm-submit"
          className={cn(CONFIRM_BUTTON_BASE, toneClass)}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {confirmLabel}
        </button>
      </div>
    </>
  );

  if (mode === "two-step") {
    const press = () => {
      const action = nextPressAction(armedValue ? "armed" : "idle");
      if (action === "arm") {
        setArmed(true);
        return;
      }
      if (
        confirmBlocked({
          pending,
          armed: true,
          typed: typedValue,
          phrase: confirmPhrase,
        })
      ) {
        return;
      }
      setArmed(false);
      if (!firedRef.current) {
        firedRef.current = true;
        onConfirm();
      }
    };

    return (
      <div
        data-testid="confirm-twostep"
        data-tone={tone}
        data-armed={armedValue ? "true" : "false"}
        data-pending={pending ? "true" : "false"}
        className={cn("inline-flex items-center gap-2", className)}
      >
        <button
          type="button"
          onClick={press}
          disabled={pending}
          aria-pressed={armedValue}
          aria-busy={pending || undefined}
          aria-label={armedValue ? confirmLabel : armLabel ?? confirmLabel}
          data-testid="confirm-twostep-action"
          className={cn(CONFIRM_BUTTON_BASE, toneClass)}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {armedValue ? confirmLabel : armLabel ?? confirmLabel}
        </button>
        {armedValue ? (
          <button
            type="button"
            onClick={() => {
              setArmed(false);
              onOpenChange(false);
            }}
            data-testid="confirm-twostep-cancel"
            aria-label={cancelLabel}
            className={CONFIRM_CANCEL_BASE}
          >
            {cancelLabel}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <FloatingHostProvider>
      <DialogPrimitive.Overlay
        data-testid="confirm-scrim"
        className="fixed inset-0 animate-fade bg-overlay"
        style={{ zIndex: Z.overlay }}
      />
      <DialogPrimitive.Content
        role="dialog"
        aria-modal="true"
        data-testid="confirm-dialog"
        data-tone={tone}
        data-pending={pending ? "true" : "false"}
        className={cn(
          "surface-raised-strong fixed left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 p-5 outline-none",
          className,
        )}
        style={{ zIndex: Z.modal }}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== document.body) {
            invokerRef.current = active;
          }
        }}
        onCloseAutoFocus={(event) => {
          const invoker = invokerRef.current;
          invokerRef.current = null;
          if (invoker?.isConnected) {
            // Skip Radix's trigger fallback (null for controlled dialogs).
            event.preventDefault();
            invoker.focus();
          }
        }}
      >
        {body}
      </DialogPrimitive.Content>
      </FloatingHostProvider>
    </DialogPrimitive.Root>
  );
}
