"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Sparkles } from "lucide-react";
import {
  createWorkspaceAction,
  deleteWorkspaceAction,
  updateWorkspaceAction,
} from "@/server/actions/workspaces";
import { useAction } from "@/lib/actions-client";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Field, Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/* ------------------------------------------------------------------------- *
 * Pure mappings — the slug preview + validation that drive the live feedback
 * (docs/DESIGN_SYSTEM.md §10). DOM-free so the node tests can pin them.
 * ------------------------------------------------------------------------- */

export const PRESET_ICONS = ["🚀", "🧠", "📚", "🏡", "🎯", "💼", "🎨", "🔬", "🌱", "⚡", "🗂️", "🤝"];

export const MAX_WORKSPACE_NAME = 80;
export const MIN_WORKSPACE_SLUG = 2;
export const MAX_WORKSPACE_SLUG = 48;

export type WorkspaceSlugStatus = "ok" | "empty" | "too-short" | "too-long" | "invalid";

/**
 * Derive the web address the server will build for a workspace name:
 * lowercased, ASCII alphanumerics, runs of anything else collapsed to a single
 * hyphen, trimmed and capped. Matches the shape `uniqueWorkspaceSlug` produces.
 */
export function slugifyWorkspaceName(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_WORKSPACE_SLUG);
}

/** Validate a derived slug; returns `ok` or the first problem. */
export function validateWorkspaceSlug(slug: string): WorkspaceSlugStatus {
  if (!slug) return "empty";
  if (slug.length < MIN_WORKSPACE_SLUG) return "too-short";
  if (slug.length > MAX_WORKSPACE_SLUG) return "too-long";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return "invalid";
  return "ok";
}

export type WorkspaceSlugPreview = {
  /** The derived slug (may be empty). */
  slug: string;
  status: WorkspaceSlugStatus;
  /** `true` only when the slug is usable. */
  valid: boolean;
};

/** The live preview shown under the name field. */
export function workspaceSlugPreview(
  name: string | null | undefined,
): WorkspaceSlugPreview {
  const slug = slugifyWorkspaceName(name);
  const status = validateWorkspaceSlug(slug);
  return { slug, status, valid: status === "ok" };
}

/** The human message for a slug status, or `null` when it is usable. */
export function workspaceSlugMessage(status: WorkspaceSlugStatus): string | null {
  switch (status) {
    case "empty":
      return "Add a name to build a web address.";
    case "too-short":
      return `Use at least ${MIN_WORKSPACE_SLUG} characters.`;
    case "too-long":
      return `Keep the address under ${MAX_WORKSPACE_SLUG} characters.`;
    case "invalid":
      return "Use lowercase letters, numbers and hyphens only.";
    default:
      return null;
  }
}

const NAME_REQUIRED_MESSAGE = "Name is required";

/* ------------------------------------------------------------------------- *
 * Entry points
 * ------------------------------------------------------------------------- */

/** Button + dialog pair, for surfaces that are not the sidebar switcher. */
export function CreateWorkspaceButton({
  label,
  locale = "en",
}: {
  label?: string;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {label ?? t(locale, "createWorkspaceButton")}
      </Button>
      <WorkspaceDialog
        open={open}
        mode="create"
        locale={locale}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Edit the current workspace name/icon from Settings, with owner-only delete. */
export function EditWorkspaceButton({
  workspaceId,
  initialName,
  initialIcon,
  locale = "en",
  canDelete = true,
}: {
  workspaceId: string;
  initialName: string;
  initialIcon: string | null;
  locale?: string;
  /** Owner-only: show the danger delete control in the dialog. */
  canDelete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="flex items-center gap-2">
        <span aria-hidden className="text-lg">
          {initialIcon ?? "🏠"}
        </span>
        <span className="text-sm">{initialName}</span>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {t(locale, "rename")} / {t(locale, "iconLabel")}
        </Button>
      </span>
      <WorkspaceDialog
        open={open}
        mode="edit"
        locale={locale}
        workspaceId={workspaceId}
        initialName={initialName}
        initialIcon={initialIcon}
        canDelete={canDelete}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Dialog
 * ------------------------------------------------------------------------- */

/**
 * Create a workspace (or edit one). One component for both so the icon picker,
 * slug preview, validation and keyboard behaviour are identical in the sidebar
 * and in settings.
 */
export function WorkspaceDialog({
  open,
  mode,
  workspaceId,
  initialName = "",
  initialSlug,
  locale,
  initialIcon = null,
  canDelete = false,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  workspaceId?: string;
  initialName?: string;
  initialSlug?: string;
  initialIcon?: string | null;
  locale: string;
  /** Owner-only destructive control (edit mode). */
  canDelete?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<string | null>(initialIcon);
  const [touched, setTouched] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) {
      setName(initialName);
      setIcon(initialIcon);
      setTouched(false);
      setTyped("");
      setConfirmOpen(false);
    }
  }, [open, initialName, initialIcon]);

  const preview = workspaceSlugPreview(name);
  const trimmedName = name.trim();
  const nameError = touched && !trimmedName ? NAME_REQUIRED_MESSAGE : null;
  const slugStatus: WorkspaceSlugStatus =
    mode === "create" ? preview.status : "ok";
  const slugError = mode === "create" && trimmedName ? workspaceSlugMessage(slugStatus) : null;
  const slugValue =
    mode === "create" ? preview.slug : (initialSlug ?? slugifyWorkspaceName(initialName));
  const canSubmit =
    Boolean(trimmedName) && (mode === "edit" || preview.valid) && !pending;

  const submit = () => {
    setTouched(true);
    if (!canSubmit) return;
    if (mode === "create") {
      run(() => createWorkspaceAction({ name: trimmedName, icon: icon ?? undefined }), {
        success: "Workspace created",
        onSuccess: (result) => {
          onClose();
          if (!("slug" in result)) return;
          router.push(result.pageId ? `/w/${result.slug}/${result.pageId}` : `/w/${result.slug}`);
          router.refresh();
        },
      });
      return;
    }
    run(() => updateWorkspaceAction({ workspaceId: workspaceId ?? "", name: trimmedName, icon }), {
      success: t(locale, "savedWord"),
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    });
  };

  const remove = () => {
    run(() => deleteWorkspaceAction(workspaceId ?? "", initialName), {
      onSuccess: () => {
        setConfirmOpen(false);
        onClose();
        router.push("/app");
        router.refresh();
      },
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent className="w-full max-w-md p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="h-4 w-4 text-muted" aria-hidden />
            {mode === "create" ? t(locale, "createWorkspace") : t(locale, "workspaceDetails")}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {mode === "create"
              ? t(locale, "createWorkspaceIntro")
              : t(locale, "workspaceDetailsIntro")}
          </p>

          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Field
              id="workspace-name"
              label={t(locale, "nameLabel")}
              required
              error={nameError}
            >
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="Acme Inc."
                maxLength={MAX_WORKSPACE_NAME}
              />
            </Field>

            <Field
              id="workspace-slug"
              label="Slug"
              error={slugError}
              hint={
                slugError ? null : (
                  <>
                    /w/<span className="text-fg">{slugValue || "…"}</span>
                  </>
                )
              }
            >
              <Input
                readOnly
                value={slugValue}
                leading={<Link2 className="h-3.5 w-3.5" />}
                aria-readonly
                placeholder="acme-inc"
                className="text-muted"
              />
            </Field>

            <fieldset>
              <legend className="text-sm font-medium">{t(locale, "iconLabel")}</legend>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {PRESET_ICONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={`${t(locale, "useEmoji")} ${option}`}
                    aria-pressed={icon === option}
                    onClick={() => setIcon(icon === option ? null : option)}
                    className={cn(
                      "grid h-8 w-8 place-items-center rounded-sm text-lg u-colors focus-ring hover:bg-surface-2",
                      icon === option && "bg-surface-2 ring-1 ring-accent",
                    )}
                  >
                    {option}
                  </button>
                ))}
                <EmojiPicker
                  locale={locale}
                  storageKey="noema:emoji-frecency:workspace"
                  onSelect={(emoji) => setIcon(emoji)}
                  className="ms-0.5"
                />
                <Input
                  aria-label={t(locale, "customEmoji")}
                  value={icon && !PRESET_ICONS.includes(icon) ? icon : ""}
                  onChange={(event) => setIcon(event.target.value.slice(0, 8) || null)}
                  placeholder="🙂"
                  size="sm"
                  className="w-14 text-center"
                />
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            {canDelete && mode === "edit" ? (
              <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium text-danger">{t(locale, "dangerZone")}</p>
                <p className="mt-1 text-xs text-muted">{t(locale, "dangerZoneBody")}</p>
                <Button
                  type="button"
                  variant="danger"
                  tone="soft"
                  size="sm"
                  className="mt-2"
                  onClick={() => setConfirmOpen(true)}
                >
                  {t(locale, "deleteWorkspace")}
                </Button>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t(locale, "cancel")}
              </Button>
              <Button type="submit" loading={pending} disabled={!canSubmit}>
                {mode === "create" ? t(locale, "createWorkspaceButton") : t(locale, "saveChanges")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {canDelete && mode === "edit" ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          tone="danger"
          title={t(locale, "deleteWorkspaceConfirm")}
          description={t(locale, "dangerZoneBody")}
          confirmLabel={t(locale, "deleteWorkspaceConfirm")}
          cancelLabel={t(locale, "cancel")}
          pending={pending}
          confirmPhrase={initialName}
          typed={typed}
          onTypedChange={setTyped}
          typedConfirmLabel={t(locale, "typeToConfirm")}
          onConfirm={remove}
        />
      ) : null}
    </>
  );
}
