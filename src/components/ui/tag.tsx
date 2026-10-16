"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { tagClass, tagStyle } from "@/lib/design-tokens";

/**
 * Tag / Chip (§9 baseline; docs/DESIGN_SYSTEM.md "Tag / chip").
 *
 * The 10-hue palette is applied only through `tagClass`/`tagStyle`, so an
 * unknown hue can never render an unstyled pill and no component ever carries a
 * raw hex. Sizes are `sm` | `md`; a leading dot inherits the hue ink via
 * `bg-current`. Interactive states (selectable press, close, undo) get
 * `.focus-ring` and never change the box, so nothing shifts.
 */

export type TagSize = "sm" | "md";

export const TAG_SIZES: readonly TagSize[] = ["sm", "md"];

const SIZE_CLASS: Record<TagSize, string> = {
  sm: "h-5 gap-1 px-1.5 text-[11px]",
  md: "h-6 gap-1.5 px-2 text-xs",
};

/** Height/padding/type classes for a tag size, defaulting to `md`. */
export function tagSizeClass(size: TagSize | null | undefined): string {
  return SIZE_CLASS[size === "sm" ? "sm" : "md"];
}

const DOT_CLASS: Record<TagSize, string> = {
  sm: "size-1",
  md: "size-1.5",
};

/** Round ink dot for a tag size (inherits the tag hue via `bg-current`). */
export function tagDotClass(size: TagSize | null | undefined): string {
  return cn("shrink-0 rounded-full bg-current", DOT_CLASS[size === "sm" ? "sm" : "md"]);
}

const CLOSE_CLASS =
  "inline-flex size-3.5 shrink-0 items-center justify-center rounded-xs opacity-70 u-colors hover:opacity-100 focus-ring";

/**
 * Removal model for a removable tag. The close control moves the chip into a
 * `pending` window; the host then either commits (after `delayMs`) or calls
 * `undo` to roll back. Pure and synchronous, so it is testable without a DOM.
 */
export type TagRemovalStatus = "idle" | "pending" | "removed";

export type TagRemovalState = { status: TagRemovalStatus };

export const TAG_REMOVAL_IDLE: TagRemovalState = { status: "idle" };

export type TagRemovalAction = "remove" | "undo" | "commit" | "reset";

export function nextTagRemoval(
  state: TagRemovalState,
  action: TagRemovalAction,
): TagRemovalState {
  switch (action) {
    case "remove":
      return state.status === "idle" ? { status: "pending" } : state;
    case "undo":
      return state.status === "pending" ? { status: "idle" } : state;
    case "commit":
      return state.status === "pending" ? { status: "removed" } : state;
    case "reset":
      return state.status === "removed" ? { status: "idle" } : state;
    default:
      return state;
  }
}

export type RemovableTagOptions = {
  /** Fired once the undo window elapses. */
  onRemove?: () => void;
  /** Fired when the user rolls the removal back. */
  onUndo?: () => void;
  /** Length of the undo window in ms (default 4000). */
  delayMs?: number;
};

export type RemovableTag = {
  status: TagRemovalStatus;
  pending: boolean;
  remove: () => void;
  undo: () => void;
  reset: () => void;
};

/**
 * Owning hook for the removal window: `remove()` starts a timer that commits
 * via `onRemove`, `undo()` cancels and calls `onUndo`. The timer is always
 * cleared on unmount, so a removed component never fires.
 */
export function useRemovableTag(options: RemovableTagOptions = {}): RemovableTag {
  const { onRemove, onUndo, delayMs = 4000 } = options;
  const [state, setState] = useState<TagRemovalState>(TAG_REMOVAL_IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeRef = useRef(onRemove);
  const undoRef = useRef(onUndo);
  removeRef.current = onRemove;
  undoRef.current = onUndo;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const remove = useCallback(() => {
    setState((prev) => nextTagRemoval(prev, "remove"));
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setState((prev) => nextTagRemoval(prev, "commit"));
      removeRef.current?.();
    }, Math.max(0, delayMs));
  }, [clear, delayMs]);

  const undo = useCallback(() => {
    clear();
    setState((prev) => nextTagRemoval(prev, "undo"));
    undoRef.current?.();
  }, [clear]);

  const reset = useCallback(() => {
    clear();
    setState((prev) => nextTagRemoval(prev, "reset"));
  }, [clear]);

  return { status: state.status, pending: state.status === "pending", remove, undo, reset };
}

export type TagProps = {
  /** Any of the 10 hues; unknown values fall back to gray via `tagStyle`. */
  hue?: string | null;
  size?: TagSize;
  /** Leading dot tinted with the hue ink. */
  dot?: boolean;
  /** Pressed state for a selectable filter chip. */
  selected?: boolean;
  /** Toggle handler; supplying it makes the chip a keyboard-focusable control. */
  onSelectedChange?: (next: boolean) => void;
  /** Show the × close control. */
  closable?: boolean;
  onClose?: () => void;
  /** Replace the × with an undo control while a removal is pending. */
  pendingRemoval?: boolean;
  onUndo?: () => void;
  disabled?: boolean;
  closeLabel?: string;
  undoLabel?: string;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "onClose" | "children" | "onClick">;

export function Tag({
  hue,
  size = "md",
  dot = false,
  selected = false,
  onSelectedChange,
  closable = false,
  onClose,
  pendingRemoval = false,
  onUndo,
  disabled = false,
  closeLabel = "Remove",
  undoLabel = "Undo",
  className,
  children,
  ...rest
}: TagProps) {
  const selectable = typeof onSelectedChange === "function" && !disabled;

  const handleKeyDown = selectable
    ? (event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onSelectedChange(!selected);
        }
      }
    : undefined;

  return (
    <span
      {...rest}
      className={cn(
        tagClass(hue),
        tagSizeClass(size),
        "align-middle select-none u-colors",
        selectable && "cursor-pointer u-interactive focus-ring",
        selected && "border-current font-semibold",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      style={{ ...tagStyle(hue) }}
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      aria-disabled={disabled || undefined}
      data-size={size}
      data-selected={selected ? "true" : undefined}
      data-removing={pendingRemoval ? "true" : undefined}
      onClick={selectable ? () => onSelectedChange(!selected) : undefined}
      onKeyDown={handleKeyDown}
    >
      {dot ? <span aria-hidden data-dot className={tagDotClass(size)} /> : null}
      <span className="truncate">{children}</span>
      {pendingRemoval && typeof onUndo === "function" ? (
        <button
          type="button"
          data-tag-undo
          aria-label={undoLabel}
          className={cn(CLOSE_CLASS, "-me-0.5")}
          onClick={(event) => {
            event.stopPropagation();
            onUndo();
          }}
        >
          ↺
        </button>
      ) : closable ? (
        <button
          type="button"
          data-tag-close
          aria-label={closeLabel}
          className={cn(CLOSE_CLASS, "-me-0.5")}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.();
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
