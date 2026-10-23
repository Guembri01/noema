"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * Input / Textarea / Field — the design-system form primitives.
 *
 * Backwards compatible: `Input` still forwards every
 * `InputHTMLAttributes` prop to the DOM `<input>` and keeps the existing
 * `className` contract (it lands on the control, not a wrapper). `size` is now
 * the design scale (`sm | md | lg`) rather than the raw HTML number.
 *
 * Additions:
 * - sizes `sm · md · lg`
 * - `invalid` → danger border + `aria-invalid="true"`
 * - `disabled` → token disabled state (shared with buttons)
 * - `leading` / `trailing` → an icon or an addon inside the field
 * - `clearable` + `onClear` → a clear affordance that appears when there is text
 * - `Field` → label + control + hint + error wired through
 *   `aria-describedby` / `aria-errormessage`
 *
 * All seven states use the shared vocabulary: hover/focus/press via
 * `.focus-ring`, disabled via the `disabled:` pair, invalid via the `danger`
 * tokens and `aria-invalid`.
 */

export type InputSize = "sm" | "md" | "lg";

/** Layout + state contract shared by Input and Textarea. */
export const INPUT_BASE =
  "w-full rounded-control border bg-bg text-fg placeholder:text-muted focus-ring u-colors disabled:cursor-not-allowed disabled:opacity-50";

export const INPUT_SIZES: Record<InputSize, string> = {
  sm: "h-8 px-2.5 text-sm",
  md: "h-9 px-3 text-sm",
  lg: "h-11 px-3.5 text-base",
};

/** Danger ring for the error state; paired with `aria-invalid`. */
export const INPUT_INVALID = "border-danger focus:border-danger";

const INPUT_CHROME = "border-control";
const TRAILING_PADDING = "pe-8";
const LEADING_PADDING = "ps-8";

/** The classes for one input configuration. Pure — pinned by the node test. */
export function inputClasses({
  size = "md",
  invalid = false,
  leading = false,
  trailing = false,
  className,
}: {
  size?: InputSize;
  invalid?: boolean;
  leading?: boolean;
  trailing?: boolean;
  className?: string;
} = {}): string {
  return cn(
    INPUT_BASE,
    INPUT_SIZES[size],
    INPUT_CHROME,
    invalid && INPUT_INVALID,
    leading && LEADING_PADDING,
    trailing && TRAILING_PADDING,
    className,
  );
}

export type TextareaSize = InputSize;

export const TEXTAREA_SIZES: Record<TextareaSize, string> = {
  sm: "min-h-16 px-2.5 py-1.5 text-sm",
  md: "min-h-20 px-3 py-2 text-sm",
  lg: "min-h-28 px-3.5 py-3 text-base",
};

/** The classes for one textarea configuration. Pure — pinned by the node test. */
export function textareaClasses({
  size = "md",
  invalid = false,
  className,
}: {
  size?: TextareaSize;
  invalid?: boolean;
  className?: string;
} = {}): string {
  return cn(
    INPUT_BASE,
    TEXTAREA_SIZES[size],
    "resize-y",
    INPUT_CHROME,
    invalid && INPUT_INVALID,
    className,
  );
}

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: InputSize;
  invalid?: boolean;
  /** Icon or addon rendered inside the field, before the text. */
  leading?: React.ReactNode;
  /** Icon or addon rendered inside the field, after the text. */
  trailing?: React.ReactNode;
  /** Show a clear button while the field has text. */
  clearable?: boolean;
  /** Called after the field is cleared (controlled consumers reset their state). */
  onClear?: () => void;
  /** Locale for the clear button's accessible name (defaults to English). */
  locale?: string;
  ref?: React.Ref<HTMLInputElement>;
}

function assignRef<T>(
  ref: React.Ref<T> | undefined,
  node: T | null,
): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
}

export function Input({
  className,
  size = "md",
  invalid = false,
  leading,
  trailing,
  clearable = false,
  onClear,
  locale = "en",
  disabled,
  value,
  defaultValue,
  onChange,
  ref,
  ...props
}: InputProps) {
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const isControlled = value !== undefined;
  const [hasText, setHasText] = React.useState(
    () => String(value ?? defaultValue ?? "").length > 0,
  );

  const showClear =
    clearable && !disabled && (isControlled ? String(value).length > 0 : hasText);
  const hasTrailing = Boolean(trailing) || showClear;
  // Keep the DOM shape stable while typing: once a clear button *can* appear we
  // always render the wrapper, so the `<input>` is never remounted (which would
  // drop focus mid-keystroke).
  const needsWrapper = Boolean(leading) || Boolean(trailing) || clearable;

  const setRefs = (node: HTMLInputElement | null) => {
    innerRef.current = node;
    assignRef(ref, node);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!isControlled) setHasText(event.target.value.length > 0);
    onChange?.(event);
  };

  const handleClear = () => {
    const node = innerRef.current;
    if (node && !isControlled) {
      node.value = "";
      setHasText(false);
      // Let uncontrolled form values observe the clear too.
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }
    onClear?.();
    node?.focus();
  };

  if (!needsWrapper) {
    return (
      <input
        {...props}
        ref={setRefs}
        className={inputClasses({ size, invalid, className })}
        disabled={disabled}
        value={value}
        defaultValue={defaultValue}
        aria-invalid={invalid || undefined}
        onChange={handleChange}
      />
    );
  }

  return (
    <span
      className="relative flex w-full items-center"
      data-slot="input-control"
    >
      {leading ? (
        <span
          className="pointer-events-none absolute start-2.5 inline-flex items-center text-muted"
          aria-hidden="true"
          data-slot="input-leading"
        >
          {leading}
        </span>
      ) : null}

      <input
        {...props}
        ref={setRefs}
        className={inputClasses({
          size,
          invalid,
          leading: Boolean(leading),
          trailing: hasTrailing,
          className,
        })}
        disabled={disabled}
        value={value}
        defaultValue={defaultValue}
        aria-invalid={invalid || undefined}
        onChange={handleChange}
      />

      {hasTrailing ? (
        <span
          className="absolute end-1.5 inline-flex items-center gap-1 text-muted"
          data-slot="input-trailing"
        >
          {trailing}
          {showClear ? (
            <button
              type="button"
              onClick={handleClear}
              aria-label={t(locale, "clear")}
              className="focus-ring u-colors inline-flex h-5 w-5 items-center justify-center rounded-xs text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: TextareaSize;
  invalid?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({
  className,
  size = "md",
  invalid = false,
  ref,
  ...props
}: TextareaProps) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={textareaClasses({ size, invalid, className })}
      aria-invalid={invalid || undefined}
    />
  );
}

export interface FieldProps {
  /** Ties the `<label>` to the control and namespaces the hint/error ids. */
  id: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Label + control + hint + error, wired by ARIA.
 *
 * The control is cloned with `aria-describedby` (hint and/or error),
 * `aria-errormessage` (when there is an error) and `aria-invalid`; the `invalid`
 * shorthand is only forwarded to our own `Input`/`Textarea` so a bare element
 * never receives an unknown `invalid` attribute.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [hintId, errorId].filter(Boolean).join(" ") || undefined;

  let control: React.ReactNode = children;
  if (React.isValidElement(children)) {
    const element = children as React.ReactElement<Record<string, unknown>>;
    const isOurControl =
      element.type === Input || element.type === Textarea;
    const override: Record<string, unknown> = {
      id,
      "aria-describedby": describedBy,
      "aria-errormessage": errorId,
      "aria-invalid": error ? true : undefined,
    };
    if (isOurControl) override.invalid = error ? true : false;
    control = React.cloneElement(element, override);
  }

  return (
    <div className={cn("space-y-1.5", className)} data-slot="field">
      {label ? (
        <label htmlFor={id} className="block text-sm font-medium text-fg">
          {label}
          {required ? (
            <span className="text-danger" aria-hidden="true">
              {" *"}
            </span>
          ) : null}
        </label>
      ) : null}
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
