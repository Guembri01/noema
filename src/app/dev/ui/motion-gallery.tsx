"use client";

import * as React from "react";
import {
  Bold,
  Check,
  ChevronRight,
  Home,
  Inbox,
  Search,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { DUR } from "@/lib/design-tokens";
import { dropIndicatorStyle } from "@/lib/drag-drop-targets";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToastView } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * The animation-behavior explorer — the `/dev/ui` section that shows the
 * *transitions* between states, not the states themselves.
 *
 * Every demo here is a live element carrying a real CSS transition whose
 * duration/easing comes from the token vocabulary (`--dur-1`…`--dur-4`,
 * `--ease-*`). Nothing fakes motion with a class name: `getComputedStyle(el)
 * .transitionDuration` on each demo resolves to the token it prints.
 *
 * Two things make it a reference rather than a screenshot:
 *
 *  - the **reduce-motion preview** (spec §10). Flipping the switch sets
 *    `data-reduced="true"` on the gallery root and collapses every demo to the
 *    `0ms` sentinel the token layer uses, so the preview matches what the real
 *    `@media (prefers-reduced-motion: reduce)` rule does to the whole app.
 *  - the demos run the same transform at the four duration tiers side by side,
 *    so the timing steps are comparable at a glance, not in prose.
 *
 * It renders inside the `animation-behavior` section of `design-gallery.tsx`;
 * the manifest entry and this component are pinned by `motion-gallery.test.ts`.
 */

/** The gallery is a developer reference; it renders in English. */
const locale = "en";

/**
 * One transition string from the token vocabulary.
 *
 * The property list and the tokens are passed in at each call site, so the
 * source never carries a raw duration. When the preview switch is on the
 * duration collapses to `0ms` — the same sentinel `globals.css` uses for
 * `prefers-reduced-motion`, never a shortened token.
 */
function motion(
  reduced: boolean,
  property: string,
  durToken: string,
  easeToken = "var(--ease-smooth)",
): React.CSSProperties {
  return { transition: `${property} ${reduced ? "0ms" : durToken} ${easeToken}` };
}

/* ------------------------------------------------------------------------- *
 * 1. Duration tiers
 * ------------------------------------------------------------------------- */

/** The four timing steps, each paired with its token and `DUR.*` mirror. */
const DURATION_TIERS = [
  { testId: "motion-dur-1", token: "var(--dur-1)", name: "--dur-1", ms: DUR.fast },
  { testId: "motion-dur-2", token: "var(--dur-2)", name: "--dur-2", ms: DUR.base },
  { testId: "motion-dur-3", token: "var(--dur-3)", name: "--dur-3", ms: DUR.slow },
  { testId: "motion-dur-4", token: "var(--dur-4)", name: "--dur-4", ms: DUR.slower },
] as const;

/** The token easings, same motion, different curve. */
const EASINGS = [
  { name: "--ease-smooth", token: "var(--ease-smooth)" },
  { name: "--ease-in-out-soft", token: "var(--ease-in-out-soft)" },
  { name: "--ease-spring", token: "var(--ease-spring)" },
] as const;

/** One lane: a token label plus a track whose bar carries the transition. */
function MotionLane({
  reduced,
  playing,
  testId,
  label,
  token,
  easeToken,
}: {
  reduced: boolean;
  playing: boolean;
  testId?: string;
  label: string;
  token: string;
  easeToken?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <code className="w-44 shrink-0 text-2xs text-muted">{label}</code>
      <span className="block h-4 w-40 shrink-0 overflow-hidden rounded-full bg-surface-2">
        <span
          data-testid={testId}
          className="block h-4 w-4 rounded-full bg-action"
          style={{
            ...motion(reduced, "transform", token, easeToken),
            transform: playing ? "translateX(144px)" : "translateX(0px)",
          }}
        />
      </span>
    </div>
  );
}

function MotionDurations({
  reduced,
  playing,
}: {
  reduced: boolean;
  playing: boolean;
}) {
  return (
    <MotionGroup
      title={t(locale, "motionDurationTiers")}
      hint={t(locale, "motionDurationHint")}
    >
      <div className="flex w-full flex-col gap-2">
        {DURATION_TIERS.map((tier) => (
          <MotionLane
            key={tier.testId}
            reduced={reduced}
            playing={playing}
            testId={tier.testId}
            label={`${tier.name} · ${tier.ms} ms`}
            token={tier.token}
          />
        ))}
      </div>
    </MotionGroup>
  );
}

function MotionEasings({
  reduced,
  playing,
}: {
  reduced: boolean;
  playing: boolean;
}) {
  return (
    <MotionGroup
      title={t(locale, "motionEasingCurves")}
      hint={t(locale, "motionEasingHint")}
    >
      <div className="flex w-full flex-col gap-2">
        {EASINGS.map((easing) => (
          <MotionLane
            key={easing.name}
            reduced={reduced}
            playing={playing}
            label={easing.name}
            token="var(--dur-3)"
            easeToken={easing.token}
          />
        ))}
      </div>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * 2. Button states
 * ------------------------------------------------------------------------- */

function MotionButtons({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup title={t(locale, "motionButtonStates")}>
      <Button
        variant="secondary"
        data-testid="motion-button-hover"
        style={motion(reduced, "background-color", "var(--dur-1)")}
      >
        {t(locale, "motionHoverButton")}
      </Button>
      <button
        type="button"
        data-testid="motion-button-press"
        className="focus-ring inline-flex h-9 items-center justify-center rounded-control bg-action px-3.5 text-sm font-medium text-action-fg active:scale-[0.98]"
        style={motion(reduced, "transform", "var(--dur-1)")}
      >
        {t(locale, "motionPressButton")}
      </button>
      <Button
        variant="secondary"
        data-testid="motion-button-focus"
        style={motion(reduced, "background-color", "var(--dur-1)")}
      >
        {t(locale, "motionFocusButton")}
      </Button>
      <Button
        data-testid="motion-button-disabled"
        disabled
        style={motion(reduced, "background-color", "var(--dur-1)")}
      >
        {t(locale, "motionDisabledButton")}
      </Button>
      <Button
        data-testid="motion-button-loading"
        loading
        style={motion(reduced, "background-color", "var(--dur-1)")}
      >
        {t(locale, "motionLoadingButton")}
      </Button>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * 3. Form controls
 * ------------------------------------------------------------------------- */

function MotionCheckbox({ reduced }: { reduced: boolean }) {
  const [checked, setChecked] = React.useState(false);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <span className="relative inline-flex h-5 w-5 shrink-0">
        <input
          type="checkbox"
          role="checkbox"
          data-testid="motion-checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
          className={cn(
            "focus-ring m-0 h-full w-full appearance-none rounded-control border bg-bg outline-none",
            checked ? "border-action bg-action" : "border-border-strong",
          )}
          style={motion(reduced, "background-color, border-color", "var(--dur-1)")}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center text-action-fg",
            checked ? "opacity-100" : "opacity-0",
          )}
          style={motion(reduced, "opacity", "var(--dur-2)")}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      </span>
      {t(locale, "selectAll")}
    </label>
  );
}

function MotionSwitch({ reduced }: { reduced: boolean }) {
  const [on, setOn] = React.useState(true);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <span
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 rounded-full border",
          on ? "border-action bg-action" : "border-border-strong bg-surface-3",
        )}
        style={motion(reduced, "background-color, border-color", "var(--dur-2)")}
      >
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          data-testid="motion-switch"
          checked={on}
          onChange={(event) => setOn(event.target.checked)}
          className="focus-ring absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-full outline-none"
          style={motion(reduced, "background-color", "var(--dur-2)")}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-0.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-bg shadow-1",
            on ? "translate-x-5" : "translate-x-0",
          )}
          style={motion(reduced, "transform", "var(--dur-2)", "var(--ease-spring)")}
        />
      </span>
      {t(locale, "syncStatus")}
    </label>
  );
}

const RADIO_OPTIONS = [
  { value: "planned", labelKey: "statusPlanned" },
  { value: "in-progress", labelKey: "statusInProgress" },
] as const;

function MotionRadio({ reduced }: { reduced: boolean }) {
  const [value, setValue] = React.useState<string>("planned");
  return (
    <div
      role="radiogroup"
      aria-label={t(locale, "priorityWord")}
      data-testid="motion-radio"
      className="flex items-center gap-4 rounded-md"
      style={motion(reduced, "background-color", "var(--dur-1)")}
    >
      {RADIO_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setValue(option.value)}
            className={cn(
              "focus-ring inline-flex items-center gap-2 rounded-control text-sm",
              selected ? "font-medium text-fg" : "text-muted",
            )}
            style={motion(reduced, "background-color, border-color", "var(--dur-1)")}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border bg-bg",
                selected ? "border-action" : "border-border-strong",
              )}
              style={motion(reduced, "border-color, background-color", "var(--dur-1)")}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-2.5 w-2.5 rounded-full bg-action",
                  selected ? "scale-100" : "scale-0",
                )}
                style={motion(reduced, "transform", "var(--dur-2)", "var(--ease-spring)")}
              />
            </span>
            {t(locale, option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function MotionFormControls({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup title={t(locale, "motionFormControls")}>
      <MotionCheckbox reduced={reduced} />
      <MotionSwitch reduced={reduced} />
      <MotionRadio reduced={reduced} />
      <div className="w-64">
        <Input
          aria-label={t(locale, "motionEmail")}
          placeholder={t(locale, "emailPlaceholder")}
        />
      </div>
      <div className="w-64">
        <Field
          id="motion-input-invalid"
          label={t(locale, "motionEmail")}
          error={t(locale, "invalidEmail")}
        >
          <Input defaultValue="not-an-email" />
        </Field>
      </div>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * 4. Spec demo A — sidebar expand / collapse
 * ------------------------------------------------------------------------- */

const SIDEBAR_ITEMS = [
  { id: "home", labelKey: "home", Icon: Home },
  { id: "search", labelKey: "search", Icon: Search },
  { id: "inbox", labelKey: "inbox", Icon: Inbox },
  { id: "settings", labelKey: "settings", Icon: Settings },
] as const;

function MotionSidebar({ reduced }: { reduced: boolean }) {
  const [open, setOpen] = React.useState(true);
  return (
    <MotionGroup
      title={t(locale, "motionSidebarDemo")}
      hint={t(locale, "motionSidebarHint")}
    >
      <div
        data-testid="motion-sidebar-demo"
        className="flex flex-col gap-2 rounded-control bg-surface-2 p-2"
        style={motion(reduced, "background-color", "var(--dur-2)")}
      >
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          style={motion(reduced, "background-color", "var(--dur-1)")}
        >
          {t(locale, "motionSidebarToggle")}
        </Button>
        <div
          data-testid="motion-sidebar-panel"
          aria-hidden={!open}
          className="overflow-hidden rounded-card border border-border bg-sidebar p-1"
          style={{
            ...motion(reduced, "width", "var(--dur-3)"),
            width: open ? 232 : 56,
          }}
        >
          {SIDEBAR_ITEMS.map((item) => (
            <span
              key={item.id}
              className="flex h-8 items-center gap-2 rounded-sm px-2 text-sm text-fg"
            >
              <item.Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span
                className="overflow-hidden whitespace-nowrap"
                style={{
                  ...motion(reduced, "opacity", "var(--dur-2)"),
                  opacity: open ? 1 : 0,
                }}
              >
                {t(locale, item.labelKey)}
              </span>
            </span>
          ))}
        </div>
      </div>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * 5. Spec demo B — expanding tab labels
 * ------------------------------------------------------------------------- */

const TAB_ITEMS = [
  { id: "home", labelKey: "home", Icon: Home },
  { id: "inbox", labelKey: "inbox", Icon: Inbox },
  { id: "settings", labelKey: "settings", Icon: Settings },
] as const;

function MotionTabs({ reduced }: { reduced: boolean }) {
  const [active, setActive] = React.useState<string>("home");
  return (
    <MotionGroup
      title={t(locale, "motionTabsDemo")}
      hint={t(locale, "motionTabsHint")}
    >
      <div
        role="tablist"
        data-testid="motion-tabs"
        className="inline-flex items-center gap-1 rounded-control bg-surface-2 p-1"
        style={motion(reduced, "background-color", "var(--dur-1)")}
      >
        {TAB_ITEMS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={t(locale, tab.labelKey)}
              onClick={() => setActive(tab.id)}
              className={cn(
                "focus-ring inline-flex items-center gap-2 rounded-control px-2 py-1 text-sm",
                selected ? "bg-bg text-fg shadow-1" : "text-muted",
              )}
              style={motion(reduced, "background-color, color", "var(--dur-1)")}
            >
              <tab.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span
                aria-hidden="true"
                className="grid overflow-hidden whitespace-nowrap"
                style={{
                  ...motion(reduced, "grid-template-columns", "var(--dur-3)"),
                  gridTemplateColumns: selected ? "1fr" : "0fr",
                }}
              >
                <span className="min-w-0 overflow-hidden">
                  {t(locale, tab.labelKey)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * 6. Spec demo C — context menu from its trigger
 * ------------------------------------------------------------------------- */

function MotionContextMenu({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup
      title={t(locale, "motionContextMenuDemo")}
      hint={t(locale, "motionContextMenuHint")}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-testid="motion-context-menu"
            className="grid h-24 w-56 place-items-center rounded-md border border-dashed border-border-strong text-sm text-muted"
            style={motion(reduced, "background-color", "var(--dur-1)")}
          >
            {t(locale, "motionContextMenuTarget")}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => {}}>{t(locale, "edit")}</ContextMenuItem>
          <ContextMenuItem onSelect={() => {}}>
            {t(locale, "properties")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem destructive onSelect={() => {}}>
            {t(locale, "deletePermanently")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * 7. Chevron rotation, shimmer, toast, tooltip, drop indicator
 * ------------------------------------------------------------------------- */

function MotionChevron({ reduced }: { reduced: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <MotionGroup title={t(locale, "motionChevronDemo")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring inline-flex items-center gap-2 rounded-control px-2 py-1 text-sm text-fg hover:bg-surface-2"
      >
        <ChevronRight
          aria-hidden="true"
          data-testid="motion-chevron"
          className="h-4 w-4"
          style={{
            ...motion(reduced, "transform", "var(--dur-2)"),
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
        {t(locale, "motionChevronDemo")}
      </button>
    </MotionGroup>
  );
}

function MotionSkeleton({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup title={t(locale, "motionSkeletonDemo")}>
      <div className="w-56">
        <Skeleton
          variant="block"
          data-testid="motion-skeleton"
          className="h-4 w-full"
          style={motion(reduced, "opacity", "var(--dur-2)")}
        />
      </div>
      <div className="w-56">
        <Skeleton variant="text" lines={3} />
      </div>
    </MotionGroup>
  );
}

function MotionToast({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup title={t(locale, "motionToastDemo")}>
      <Button
        variant="secondary"
        onClick={() =>
          toast(t(locale, "motionToastTitle"), {
            description: t(locale, "motionToastDescription"),
          })
        }
        style={motion(reduced, "background-color", "var(--dur-1)")}
      >
        {t(locale, "motionToastShow")}
      </Button>
      <div
        data-testid="motion-toast"
        style={motion(reduced, "opacity", "var(--dur-2)")}
      >
        <ToastView
          variant="success"
          title={t(locale, "motionToastTitle")}
          description={t(locale, "motionToastDescription")}
        />
      </div>
    </MotionGroup>
  );
}

function MotionTooltip({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup title={t(locale, "motionTooltipDemo")}>
      <Tooltip label={t(locale, "motionTooltipLabel")}>
        <Button
          variant="ghost"
          size="iconOnly"
          data-testid="motion-tooltip"
          aria-label={t(locale, "motionTooltipLabel")}
          style={motion(reduced, "background-color", "var(--dur-1)")}
        >
          <Bold className="h-4 w-4" />
        </Button>
      </Tooltip>
    </MotionGroup>
  );
}

const DROP_ROWS = ["home", "search", "settings"] as const;

function MotionDropIndicator({ reduced }: { reduced: boolean }) {
  return (
    <MotionGroup
      title={t(locale, "motionDropIndicatorDemo")}
      hint={t(locale, "motionDropIndicatorHint")}
    >
      <ul
        className="flex w-64 flex-col gap-1"
        aria-label={t(locale, "motionDropIndicatorDemo")}
      >
        {DROP_ROWS.map((key, index) => (
          <li
            key={key}
            data-testid={index === 1 ? "motion-drop-indicator" : undefined}
            className="rounded-chip border border-transparent bg-surface-2 px-2 py-1 text-sm text-fg"
            style={{
              ...(index === 1
                ? dropIndicatorStyle({ index, mode: "before" })
                : {}),
              ...motion(reduced, "border-color, background-color", "var(--dur-1)"),
            }}
          >
            {t(locale, key)}
          </li>
        ))}
      </ul>
    </MotionGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * Shared chrome
 * ------------------------------------------------------------------------- */

function MotionGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-4">
        {children}
      </div>
    </section>
  );
}

/** The preview switch. It flips `data-reduced` on the gallery root. */
function MotionReduceToggle({
  reduced,
  onReducedChange,
}: {
  reduced: boolean;
  onReducedChange: (next: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <span
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 rounded-full border",
          reduced ? "border-action bg-action" : "border-border-strong bg-surface-3",
        )}
        style={motion(false, "background-color, border-color", "var(--dur-2)")}
      >
        <input
          type="checkbox"
          role="switch"
          aria-checked={reduced}
          aria-label={t(locale, "motionReduceLabel")}
          data-testid="motion-reduce-toggle"
          checked={reduced}
          onChange={(event) => onReducedChange(event.target.checked)}
          className="focus-ring absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-full outline-none"
          style={motion(false, "background-color", "var(--dur-2)")}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-0.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-bg shadow-1",
            reduced ? "translate-x-5" : "translate-x-0",
          )}
          style={motion(false, "transform", "var(--dur-2)", "var(--ease-spring)")}
        />
      </span>
      {t(locale, "motionReduceLabel")}
    </label>
  );
}

/* ------------------------------------------------------------------------- *
 * The explorer
 * ------------------------------------------------------------------------- */

export function MotionGallery() {
  const [reduced, setReduced] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);

  return (
    <div
      data-testid="motion-gallery"
      data-reduced={reduced ? "true" : undefined}
      className="flex flex-col gap-8"
      style={motion(reduced, "background-color", "var(--dur-1)")}
    >
      <p className="max-w-3xl text-sm leading-6 text-muted">
        {t(locale, "motionGalleryIntro")}
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">
          {t(locale, "motionReduceDemo")}
        </h3>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPlaying((value) => !value)}
            style={motion(reduced, "background-color", "var(--dur-1)")}
          >
            {t(locale, "motionReplay")}
          </Button>
          <MotionReduceToggle reduced={reduced} onReducedChange={setReduced} />
          <p className="text-xs text-muted">{t(locale, "motionReduceHint")}</p>
        </div>
      </section>

      <MotionDurations reduced={reduced} playing={playing} />
      <MotionEasings reduced={reduced} playing={playing} />
      <MotionButtons reduced={reduced} />
      <MotionFormControls reduced={reduced} />
      <MotionSidebar reduced={reduced} />
      <MotionTabs reduced={reduced} />
      <MotionContextMenu reduced={reduced} />
      <MotionChevron reduced={reduced} />
      <MotionSkeleton reduced={reduced} />
      <MotionToast reduced={reduced} />
      <MotionTooltip reduced={reduced} />
      <MotionDropIndicator reduced={reduced} />
    </div>
  );
}
