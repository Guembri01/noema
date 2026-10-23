"use client";

import {
  canRun,
  dryRun,
  isAllowedActionUrl,
  planRowButton,
  validateButtonConfig,
  type ButtonAction,
  type ButtonPlanStep,
  type ButtonPropertyConfig,
  type ButtonRole,
} from "@/lib/button-property";
import { type ButtonRow } from "@/lib/row-buttons";
import { t } from "@/lib/i18n";
import type { DBProperty, DBRow } from "@/components/database/database-types";

/** A BUTTON property's stored action, adapted for the `@/lib/button-property` engine. */
export type RowButtonSource = {
  config: ButtonPropertyConfig;
  label: string;
  legacy: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map one stored row-button action (`kind`-discriminated, `@/lib/row-buttons`)
 * onto the Button-property engine's `type`-discriminated `ButtonAction`.
 */
function toPropertyAction(action: unknown): ButtonAction | null {
  if (!isRecord(action)) return null;
  switch (action.kind) {
    case "open_url":
      return {
        type: "open_url",
        url: typeof action.url === "string" ? action.url : "",
        openInNewTab: action.openInNewTab !== false,
      };
    case "set_property":
      return {
        type: "set_property",
        propertyId: typeof action.propertyId === "string" ? action.propertyId : "",
        value: action.value,
      };
    case "insert_template":
      return {
        type: "insert_template",
        templateId: typeof action.templateId === "string" ? action.templateId : "",
      };
    case "notify":
      return {
        type: "notify",
        message: typeof action.message === "string" ? action.message : "",
        ...(typeof action.level === "string"
          ? { level: action.level as "info" | "success" | "warning" }
          : {}),
      };
    default:
      return null;
  }
}

export function readRowButton(
  property: DBProperty,
  fallbackLabel: string,
): RowButtonSource | undefined {
  const config = property.config;
  if (!config || typeof config !== "object") return undefined;

  if ("button" in config && config.button !== undefined) {
    const raw = config.button;
    if (isRecord(raw) && Array.isArray(raw.actions)) {
      const label =
        typeof raw.label === "string" && raw.label.trim() !== ""
          ? raw.label
          : fallbackLabel;
      return { config: raw as ButtonPropertyConfig, label, legacy: false };
    }
    if (isRecord(raw)) {
      const label =
        typeof raw.label === "string" && raw.label.trim() !== ""
          ? raw.label
          : fallbackLabel;
      const action = isRecord(raw.action) ? raw.action : undefined;
      const mapped = action ? toPropertyAction(action) : null;
      return {
        legacy: false,
        label,
        config: {
          actions: [mapped ?? (action as ButtonAction)],
          ...(typeof raw.showLabelInCell === "boolean"
            ? { showLabelInCell: raw.showLabelInCell }
            : {}),
          ...(typeof raw.confirmRequired === "boolean"
            ? { confirmRequired: raw.confirmRequired }
            : {}),
        },
      };
    }
  }

  if (
    "targetPropertyId" in config &&
    typeof config.targetPropertyId === "string" &&
    config.targetPropertyId !== ""
  ) {
    return {
      legacy: true,
      label: fallbackLabel,
      config: {
        actions: [
          {
            type: "set_property",
            propertyId: config.targetPropertyId,
            value: "value" in config ? config.value ?? { checked: true } : { checked: true },
          },
        ],
      },
    };
  }
  return undefined;
}

export function buttonStepUnrunnableReason(step: ButtonPlanStep | undefined): string {
  switch (step?.kind) {
    case "set_property":
      return "This property-write button runs from automations.";
    case "insert_template":
      return "Insert-template buttons run from automations.";
    case "notify":
      return "Notification buttons run from automations.";
    case "duplicate_row":
      return "Duplicate-row buttons run from automations.";
    case "delete_row":
      return "Delete-row buttons run from automations.";
    case "webhook":
      return "Webhook buttons run from automations.";
    default:
      return "This button is not runnable in this view.";
  }
}

function buttonPreviewValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined) return "nothing";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * BUTTON cell. The engine owns validation, the ordered plan and the destructive
 * permission gate; this component owns the non-blocking two-click confirmation
 * (no `window.confirm`) and the two executable shapes: a safe link and the
 * legacy property write.
 */
export function ButtonCell({
  property,
  value,
  editable,
  locale,
  row,
  onRunButton,
  actingRole,
}: {
  property: DBProperty;
  value: unknown;
  editable: boolean;
  locale: string;
  row?: DBRow;
  onRunButton?: () => void;
  actingRole?: ButtonRole;
}) {
  const readOnly = (text: string) => (
    <span className="min-w-0 max-w-full truncate text-muted">{text}</span>
  );
  const buttonLabel = t(locale, "runWord");
  const source = readRowButton(property, buttonLabel);
  if (source === undefined) {
    return editable && onRunButton ? (
      <button
        type="button"
        onClick={onRunButton}
        aria-label={buttonLabel}
        className="focus-ring u-interactive rounded-control border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
      >
        {buttonLabel}
      </button>
    ) : (
      readOnly("—")
    );
  }

  const buttonRow: ButtonRow = (() => {
    if (!row) return { id: "", values: { [property.id]: value } };
    const values: Record<string, unknown> = {};
    for (const entry of row.propertyValues) values[entry.propertyId] = entry.value;
    return { id: row.id, title: row.title, values };
  })();
  const issues = validateButtonConfig(source.config);
  const plan = planRowButton(source.config, { row: buttonRow });
  const step: ButtonPlanStep | undefined = plan[0];
  const role: ButtonRole = actingRole ?? (editable ? "editor" : "viewer");
  const permitted = canRun(source.config, { role });
  const label = source.label || buttonLabel;
  const reason =
    issues.length > 0
      ? issues[0].message
      : !permitted
        ? "Your role cannot run this button."
        : step?.kind === "open_url"
          ? "This link is not safe to open."
          : buttonStepUnrunnableReason(step);

  const confirmRun = (element?: HTMLElement | null): boolean => {
    if (source.config.confirmRequired !== true) return true;
    if (typeof window === "undefined") return true;
    if (element?.dataset.confirmArmed === "1") return true;
    const preview = dryRun(source.config, { row: buttonRow });
    const detail = preview.changes
      .map(
        (change) =>
          `${change.propertyId}: ${buttonPreviewValue(change.before)} → ${buttonPreviewValue(change.after)}`,
      )
      .join("; ");
    const message = detail
      ? `${label}\n${detail}\nClick again to confirm.`
      : preview.destructive
        ? `${label}\nThis action cannot be undone.\nClick again to confirm.`
        : `${label}\nClick again to confirm.`;
    if (element) {
      element.dataset.confirmArmed = "1";
      element.title = message;
    }
    return false;
  };

  if (
    issues.length === 0 &&
    permitted &&
    step?.kind === "open_url" &&
    isAllowedActionUrl(step.payload.url)
  ) {
    return (
      <a
        href={step.payload.url}
        target={step.payload.openInNewTab ? "_blank" : undefined}
        rel={step.payload.openInNewTab ? "noreferrer noopener" : undefined}
        onClick={(event) => {
          if (!confirmRun(event.currentTarget)) event.preventDefault();
        }}
        className="focus-ring inline-block max-w-full truncate rounded-control border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
      >
        {label}
      </a>
    );
  }

  if (source.legacy && issues.length === 0 && permitted && step?.kind === "set_property") {
    return editable && onRunButton ? (
      <button
        type="button"
        onClick={(event) => {
          if (confirmRun(event.currentTarget)) onRunButton();
        }}
        className="focus-ring max-w-full truncate rounded-control border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
      >
        {label}
      </button>
    ) : (
      readOnly("—")
    );
  }

  return (
    <button
      type="button"
      disabled
      title={reason}
      aria-label={`${label}: ${reason}`}
      data-testid="button-cell-disabled"
      className="focus-ring u-interactive max-w-full truncate rounded-control border border-border px-2 py-0.5 text-xs opacity-60"
    >
      {label}
    </button>
  );
}
