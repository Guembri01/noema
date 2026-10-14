"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { createWorkspaceAction, updateWorkspaceAction } from "@/server/actions/workspaces";
import { useAction } from "@/lib/actions-client";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const PRESET_ICONS = ["🚀", "🧠", "📚", "🏡", "🎯", "💼", "🎨", "🔬", "🌱", "⚡", "🗂️", "🤝"];

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 rounded bg-accent px-3 text-sm text-accent-fg"
      >
        {label}
      </button>
      <WorkspaceDialog
        open={open}
        mode="create"
        locale={locale}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Edit the current workspace name/icon from Settings. */
export function EditWorkspaceButton({
  workspaceId,
  initialName,
  initialIcon,
  locale = "en",
}: {
  workspaceId: string;
  initialName: string;
  initialIcon: string | null;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="flex items-center gap-2">
        <span aria-hidden className="text-lg">
          {initialIcon ?? "🏠"}
        </span>
        <span className="text-sm">{initialName}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-8 rounded border border-border px-2.5 text-xs hover:bg-surface-2"
        >
          Rename / icon
        </button>
      </span>
      <WorkspaceDialog
        open={open}
        mode="edit"
        locale={locale}
        workspaceId={workspaceId}
        initialName={initialName}
        initialIcon={initialIcon}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * Create a workspace (or edit one). One component for both so the icon picker,
 * validation and keyboard behaviour are identical in the sidebar and in settings.
 */
export function WorkspaceDialog({
  open,
  mode,
  workspaceId,
  initialName = "",
  locale,
  initialIcon = null,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  workspaceId?: string;
  initialName?: string;
  initialIcon?: string | null;
  locale: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<string | null>(initialIcon);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setIcon(initialIcon);
    }
  }, [open, initialName, initialIcon]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === "create") {
      run(() => createWorkspaceAction({ name: trimmed, icon: icon ?? undefined }), {
        success: `Workspace “${trimmed}” created`,
        onSuccess: (result) => {
          onClose();
          if (!("slug" in result)) return;
          router.push(result.pageId ? `/w/${result.slug}/${result.pageId}` : `/w/${result.slug}`);
          router.refresh();
        },
      });
      return;
    }
    run(() => updateWorkspaceAction({ workspaceId: workspaceId ?? "", name: trimmed, icon }), {
      success: "Workspace updated",
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-full max-w-md rounded-xl border border-border bg-bg p-4 shadow-2xl">
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
          <label className="block text-sm">
            {t(locale, "nameLabel")}
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme Inc."
              maxLength={80}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            />
          </label>

          <fieldset>
            <legend className="text-sm">{t(locale, "iconLabel")}</legend>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {PRESET_ICONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`${t(locale, "useEmoji")} ${option}`}
                  aria-pressed={icon === option}
                  onClick={() => setIcon(icon === option ? null : option)}
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded text-lg hover:bg-surface-2",
                    icon === option && "bg-surface-2 ring-1 ring-accent",
                  )}
                >
                  {option}
                </button>
              ))}
              <input
                aria-label={t(locale, "customEmoji")}
                value={icon && !PRESET_ICONS.includes(icon) ? icon : ""}
                onChange={(event) => setIcon(event.target.value.slice(0, 8) || null)}
                placeholder="🙂"
                className="h-8 w-12 rounded border border-border bg-bg px-1 text-center text-sm outline-none focus:border-accent"
              />
            </div>
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
            >
              {t(locale, "cancel")}
            </button>
            <button
              type="submit"
              disabled={pending || !name.trim()}
              className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-40"
            >
              {pending ? t(locale, "working") : mode === "create" ? t(locale, "createWorkspaceButton") : t(locale, "saveChanges")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
