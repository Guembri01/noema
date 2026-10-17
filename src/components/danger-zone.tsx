"use client";

/**
 * Danger zone — the destructive settings block.
 *
 * Design-system adoption (docs/DESIGN_SYSTEM.md):
 * - a danger-toned `Section` (`--danger` on the heading, neutral surface);
 * - each destructive action sits in a neutral `Card` and hides behind a danger
 *   `ConfirmDialog` that requires the workspace name to be typed;
 * - the dialog's `pending` state disables the confirm button, so a destructive
 *   action can never be double-submitted.
 *
 * `confirmPhraseMatches` mirrors the server's exact-name check; `DangerAction`
 * is the presentational action + dialog and is exported for the node tests.
 */

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";import { deleteWorkspaceAction } from "@/server/actions/workspaces";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Section } from "@/components/ui/section";

/* -------------------------------------------------------------------------- */
/* Pure mapping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Does the typed confirmation match the required phrase?
 *
 * The typed value is trimmed (the server compares `confirmation.trim()`); the
 * phrase is compared verbatim, so case matters — exactly like the server.
 */
export function confirmPhraseMatches(typed: string, phrase: string): boolean {
  return typed.trim() === phrase;
}

/* -------------------------------------------------------------------------- */
/* Presentational action                                                       */
/* -------------------------------------------------------------------------- */

export type DangerActionProps = {
  title: string;
  description: string;
  icon?: ReactNode;
  triggerLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  typedLabel: string;
  /** The exact phrase the user must type (usually the workspace name). */
  phrase: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  typed: string;
  onTypedChange: (value: string) => void;
  pending?: boolean;
  onConfirm: () => void;
};

/**
 * One destructive action: a neutral row with a danger trigger, and the danger
 * confirm dialog that gates it behind the typed phrase.
 */
export function DangerAction({
  title,
  description,
  icon,
  triggerLabel,
  confirmLabel,
  cancelLabel,
  typedLabel,
  phrase,
  open,
  onOpenChange,
  typed,
  onTypedChange,
  pending = false,
  onConfirm,
}: DangerActionProps) {
  return (
    <Card variant="flat" padding="md" data-testid="danger-action">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {icon ? (
            <span className="mt-0.5 flex shrink-0 items-center text-danger">
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{title}</p>
            <p className="mt-0.5 text-sm text-muted">{description}</p>
          </div>
        </div>
        <Button
          variant="danger"
          tone="soft"
          onClick={() => onOpenChange(true)}
        >
          {triggerLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        tone="danger"
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        confirmPhrase={phrase}
        typed={typed}
        onTypedChange={onTypedChange}
        typedConfirmLabel={typedLabel}
        pending={pending}
        onConfirm={onConfirm}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Container                                                                   */
/* -------------------------------------------------------------------------- */

export function DangerZone({
  workspaceId,
  workspaceName,
  locale,
  canDelete,
}: {
  workspaceId: string;
  workspaceName: string;
  canDelete: boolean;
  locale: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const confirm = useCallback(() => {
    if (!confirmPhraseMatches(typed, workspaceName) || pending) return;
    run(() => deleteWorkspaceAction(workspaceId, typed), {
      success: "Workspace deleted",
      onSuccess: () => {
        setOpen(false);
        setTyped("");
        router.push("/app");
        router.refresh();
      },
    });
  }, [pending, run, router, typed, workspaceId, workspaceName]);

  if (!canDelete) return null;

  return (
    <Section
      tone="danger"
      title={t(locale, "dangerZone")}
      description={t(locale, "dangerZoneBody")}
    >
      <DangerAction
        title={t(locale, "deleteWorkspace")}
        description={t(locale, "dangerZoneBody")}
        icon={<TriangleAlert className="h-4 w-4" aria-hidden />}
        triggerLabel={t(locale, "deleteWorkspace")}
        confirmLabel={t(locale, "deleteWorkspaceConfirm")}
        cancelLabel={t(locale, "cancel")}
        typedLabel={t(locale, "typeToConfirm")}
        phrase={workspaceName}
        open={open}
        onOpenChange={setOpen}
        typed={typed}
        onTypedChange={setTyped}
        pending={pending}
        onConfirm={confirm}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Section>
  );
}
