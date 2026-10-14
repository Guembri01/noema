"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, LayoutGrid, Sparkles, Table2, Users } from "lucide-react";
import { toast } from "sonner";
import {
  createBlockTemplateAction,
  createGalleryTemplateAction,
  createQuickStartAction,
} from "@/server/actions/home-templates";
import {
  GALLERY_TEMPLATES,
  OTHER_TEMPLATES,
  type GalleryAccent,
  type GalleryTemplate,
} from "@/lib/workflow-templates";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";


const ACCENTS: Record<GalleryAccent, { border: string; bg: string; text: string; bar: string }> = {
  green: { border: "var(--accent-green-border, #cfe6d8)", bg: "#f2f9f5", text: "#1d6f47", bar: "#c8e3d5" },
  blue: { border: "#d3e4f7", bg: "#f2f8fd", text: "#1c5cab", bar: "#c9dff4" },
  gray: { border: "#e5e5e3", bg: "#f7f7f6", text: "#4a4a47", bar: "#e2e2df" },
  red: { border: "#f6d9d7", bg: "#fdf4f3", text: "#a3322e", bar: "#f1d2d0" },
  orange: { border: "#f6e2cd", bg: "#fdf7f0", text: "#a3541c", bar: "#f2ddc6" },
  yellow: { border: "#f4e8c8", bg: "#fdfaf0", text: "#8a6414", bar: "#f0e3c0" },
  purple: { border: "#e5dcf3", bg: "#f8f5fd", text: "#5b3d9e", bar: "#e2d7f2" },
  pink: { border: "#f5dae5", bg: "#fdf5f8", text: "#a33566", bar: "#f0d4e0" },
};

function MiniTable({ accent, rows = 4 }: { accent: GalleryAccent; rows?: number }) {
  const tone = ACCENTS[accent];
  return (
    <div
      className="overflow-hidden rounded-md border bg-white"
      style={{ borderColor: tone.border }}
      aria-hidden
    >
      <div className="flex items-center gap-1 border-b px-1.5 py-1" style={{ borderColor: tone.border }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.bar }} />
        <span className="h-1 flex-1 rounded-full" style={{ background: tone.bar }} />
        <span className="h-1 w-4 rounded-full" style={{ background: tone.bar }} />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-1 border-b px-1.5 py-1 last:border-b-0" style={{ borderColor: tone.border }}>
          <span className="h-1 rounded-full" style={{ background: tone.bar, width: `${70 - index * 8}%` }} />
          <span className="ml-auto h-1 w-3 rounded-full" style={{ background: tone.bar }} />
        </div>
      ))}
    </div>
  );
}

function MiniBoard({ accent }: { accent: GalleryAccent }) {
  const tone = ACCENTS[accent];
  return (
    <div className="grid grid-cols-3 gap-1" aria-hidden>
      {[0, 1, 2].map((column) => (
        <div key={column} className="space-y-1 rounded-md border p-1" style={{ borderColor: tone.border }}>
          <span className="block h-1 w-6 rounded-full" style={{ background: tone.bar }} />
          {Array.from({ length: 3 - column }).map((_, index) => (
            <span
              key={index}
              className="block h-3 rounded border bg-white"
              style={{ borderColor: tone.border, width: `${90 - index * 15}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The workspace home: quick starts plus the workflow template gallery. */
export function HomeGallery({
  workspaceId,
  workspaceName,
  locale,
}: {
  workspaceId: string;
  workspaceName: string;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showOther, setShowOther] = useState(false);

  const run = (action: () => Promise<{ ok: true; id: string; slug: string } | { error: string }>) =>
    startTransition(async () => {
      const result = await action();
      if ("ok" in result) {
        router.push(`/w/${result.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const card = (template: GalleryTemplate) => {
    const tone = ACCENTS[template.accent];
    return (
      <button
        key={template.id}
        type="button"
        disabled={pending}
        aria-label={template.label}
        onClick={() =>
          run(() =>
            createGalleryTemplateAction({ workspaceId, templateId: template.id }),
          )
        }
        className="overflow-hidden rounded-xl border text-left transition hover:shadow-md disabled:opacity-60"
        style={{ borderColor: tone.border, background: tone.bg }}
      >
        <div className="space-y-0.5 px-4 pt-4 pb-2" style={{ color: tone.text }}>
          <p className="text-sm font-medium">{template.label}</p>
          <p className="text-xs opacity-70">{template.description}</p>
        </div>
        <div className="px-4 pb-4 pt-1">
          {template.boardBy ? (
            <MiniBoard accent={template.accent} />
          ) : (
            <MiniTable accent={template.accent} />
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="w-full max-w-2xl self-center">
      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          disabled={pending}
          aria-label={t(locale, "emptyPage")}
          onClick={() => run(() => createQuickStartAction({ workspaceId, kind: "page" }))}
          className="rounded-xl border border-border px-4 py-4 text-left transition hover:bg-surface-2 disabled:opacity-60"
        >
          <FileText className="mb-2 h-5 w-5 text-muted" />
          <p className="text-sm font-medium">{t(locale, "emptyPage")}</p>
        </button>
        <button
          type="button"
          disabled={pending}
          aria-label={t(locale, "emptyDatabase")}
          onClick={() => run(() => createQuickStartAction({ workspaceId, kind: "database" }))}
          className="rounded-xl border border-border px-4 py-4 text-left transition hover:bg-surface-2 disabled:opacity-60"
        >
          <Table2 className="mb-2 h-5 w-5 text-muted" />
          <p className="text-sm font-medium">{t(locale, "emptyDatabase")}</p>
        </button>
      </div>

      <div className="mt-6 flex items-center gap-2 text-muted">
        <LayoutGrid className="h-4 w-4" />
        <span className="text-sm font-medium">{t(locale, "templates")}</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {GALLERY_TEMPLATES.map(card)}
      </div>

      <button
        type="button"
        onClick={() => setShowOther((value) => !value)}
        className="mt-6 text-left text-sm font-medium text-muted hover:text-fg"
      >
        {t(locale, "otherTemplates")}
      </button>

      {showOther && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OTHER_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={pending}
              aria-label={template.label}
              onClick={() =>
                run(() =>
                  createBlockTemplateAction({ workspaceId, templateId: template.id }),
                )
              }
              className="rounded-xl border border-border px-4 py-3 text-left transition hover:bg-surface-2 disabled:opacity-60"
            >
              <Sparkles className="mb-1 h-4 w-4 text-muted" />
              <p className="text-sm font-medium">{template.label}</p>
              <p className="text-xs text-muted">{template.hint}</p>
            </button>
          ))}
        </div>
      )}

      <p className={cn("mt-8 flex items-center gap-1.5 text-xs text-muted")}>
        <Users className="h-3.5 w-3.5" />
        {t(locale, "homeFooterA")} {workspaceName} {t(locale, "homeFooterB")}
      </p>
    </div>
  );
}
