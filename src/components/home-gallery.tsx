"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FileText, LayoutGrid, Sparkles, Table2, Users } from "lucide-react";
import { toast } from "sonner";
import {
  createBlockTemplateAction,
  createGalleryTemplateAction,
  createQuickStartAction,
  instantiateWorkspaceTemplateAction,
  listWorkspaceTemplatesAction,
} from "@/server/actions/home-templates";
import {
  GALLERY_TEMPLATES,
  OTHER_TEMPLATES,
  type GalleryAccent,
  type GalleryTemplate,
} from "@/lib/workflow-templates";
import { describeTemplate, type PageTemplate } from "@/lib/template-gallery";
import { isTagHue } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------------- *
 * Pure mappings — the gallery's colour + geometry decisions, kept DOM-free so
 * the node tests can pin them. Every colour is a CSS token variable; no raw hex
 * may ever appear here (docs/DESIGN_SYSTEM.md §1).
 * ------------------------------------------------------------------------- */

/** The eight accents a gallery template may declare, in palette order. */
export const GALLERY_ACCENTS: readonly GalleryAccent[] = [
  "green",
  "blue",
  "gray",
  "red",
  "orange",
  "yellow",
  "purple",
  "pink",
];

/** Type guard for an accent coming from template data. */
export function isGalleryAccent(value: unknown): value is GalleryAccent {
  return (
    typeof value === "string" &&
    (GALLERY_ACCENTS as readonly string[]).includes(value)
  );
}

/** The preview strip drawn under a template card. */
export type TemplatePreview = {
  /** The safe accent (unknown values fall back to `gray`). */
  accent: GalleryAccent;
  /** A subtle token gradient for the preview frame. */
  gradient: string;
  /** The preview frame's border colour token. */
  border: string;
  /** Which mini-layout to draw — a board when the template groups by a property. */
  shape: "board" | "table";
};

/** Which mini-layout a template asks for: a board when it has a grouping. */
export function templatePreviewShape(boardBy?: string | null): "board" | "table" {
  return boardBy ? "board" : "table";
}

/**
 * Map a template's accent onto its preview styling. The hue is validated
 * against the tag palette first, so an unknown value can never render an
 * unstyled (or raw-hex) frame.
 */
export function templatePreview(
  accent: string | null | undefined,
  boardBy?: string | null,
): TemplatePreview {
  const safe: GalleryAccent = isGalleryAccent(accent) ? accent : "gray";
  const hue = isTagHue(safe) ? safe : "gray";
  return {
    accent: safe,
    gradient: `linear-gradient(135deg, var(--tag-${hue}-bg) 0%, var(--surface-2) 100%)`,
    border: `var(--tag-${hue}-bd)`,
    shape: templatePreviewShape(boardBy),
  };
}

/** How many skeleton cards stand in for the async workspace templates. */
export const GALLERY_TEMPLATE_SKELETONS = 3;

/**
 * The quick-start tiles offered above the gallery, in order. Pure so the
 * surface never drifts from the two kinds the action accepts.
 */
export function quickStartKinds(): readonly ("page" | "database")[] {
  return ["page", "database"];
}

/* ------------------------------------------------------------------------- *
 * Preview chrome
 * ------------------------------------------------------------------------- */

/** Shared disabled affordance for the gallery's button-cards (pending state). */
const GALLERY_CARD_STATE = "text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

function MiniTable() {
  return (
    <div className="overflow-hidden rounded-sm border border-border-strong bg-bg" aria-hidden>
      <div className="flex items-center gap-1 border-b border-border-strong px-1.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-surface-3" />
        <span className="h-1 flex-1 rounded-full bg-surface-3" />
        <span className="h-1 w-4 rounded-full bg-surface-3" />
      </div>
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="flex items-center gap-1 border-b border-border px-1.5 py-1 last:border-b-0"
        >
          <span
            className="h-1 rounded-full bg-surface-3"
            style={{ width: `${70 - index * 8}%` }}
          />
          <span className="ms-auto h-1 w-3 rounded-full bg-surface-3" />
        </div>
      ))}
    </div>
  );
}

function MiniBoard() {
  return (
    <div className="grid grid-cols-3 gap-1" aria-hidden>
      {[0, 1, 2].map((column) => (
        <div key={column} className="space-y-1 rounded-sm border border-border-strong p-1">
          <span className="block h-1 w-6 rounded-full bg-surface-3" />
          {[0, 1, 2].slice(0, 3 - column).map((index) => (
            <span
              key={index}
              className="block h-3 rounded-sm border border-border bg-bg"
              style={{ width: `${90 - index * 15}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function TemplatePreview({ accent, boardBy }: { accent: GalleryAccent; boardBy?: string }) {
  const preview = templatePreview(accent, boardBy);
  return (
    <div
      data-testid="template-preview"
      data-shape={preview.shape}
      className="p-2"
      style={{ backgroundImage: preview.gradient, border: `1px solid ${preview.border}` }}
    >
      {preview.shape === "board" ? <MiniBoard /> : <MiniTable />}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Gallery
 * ------------------------------------------------------------------------- */

type LoadState = "loading" | "ready" | "error";

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
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [showOther, setShowOther] = useState(false);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<PageTemplate[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  // The workspace's saved templates (row templates projected onto the gallery
  // model). Loaded client-side so the home page keeps its lighter server tree.
  const loadTemplates = useCallback(() => {
    let active = true;
    setLoadState("loading");
    listWorkspaceTemplatesAction({ workspaceId, sort: "name" })
      .then((result) => {
        if (!active) return;
        if ("ok" in result) {
          setWorkspaceTemplates(result.templates);
          setLoadState("ready");
        } else {
          setLoadState("error");
        }
      })
      .catch(() => {
        if (active) setLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  useEffect(() => loadTemplates(), [loadTemplates]);

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

  const templateCard = (template: GalleryTemplate) => (
    <Card
      key={template.id}
      as="button"
      type="button"
      variant="interactive"
      padding="none"
      aria-label={template.label}
      aria-disabled={pending || undefined}
      onClick={() => {
        if (pending) return;
        run(() => createGalleryTemplateAction({ workspaceId, templateId: template.id }));
      }}
      className={cn(GALLERY_CARD_STATE, "overflow-hidden")}
    >
      <div className="p-4 pb-2">
        <p className="text-sm font-medium text-fg">{template.label}</p>
        <p className="mt-0.5 text-xs text-muted">{template.description}</p>
      </div>
      <div className="px-4 pb-4">
        <TemplatePreview accent={template.accent} boardBy={template.boardBy} />
      </div>
    </Card>
  );

  const workspaceCard = (template: PageTemplate) => (
    <Card
      key={template.id}
      as="button"
      type="button"
      variant="interactive"
      padding="md"
      aria-label={template.name}
      aria-disabled={pending || undefined}
      onClick={() => {
        if (pending) return;
        run(() => instantiateWorkspaceTemplateAction({ workspaceId, templateId: template.id }));
      }}
      className={GALLERY_CARD_STATE}
    >
      <p className="truncate text-sm font-medium text-fg">
        <span aria-hidden>{template.icon ?? "📄"} </span>
        {template.name}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted">{describeTemplate(template)}</p>
    </Card>
  );

  const quickStart = (kind: "page" | "database") => {
    const label = kind === "page" ? t(locale, "emptyPage") : t(locale, "emptyDatabase");
    const Icon = kind === "page" ? FileText : Table2;
    return (
      <Card
        key={kind}
        as="button"
        type="button"
        variant="interactive"
        padding="md"
        aria-label={label}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          run(() => createQuickStartAction({ workspaceId, kind }));
        }}
        className={GALLERY_CARD_STATE}
      >
        <Icon className="mb-2 h-5 w-5 text-muted" aria-hidden />
        <p className="text-sm font-medium text-fg">{label}</p>
      </Card>
    );
  };

  return (
    <div className="w-full">
      <div className="grid gap-4 sm:grid-cols-2">
        {quickStartKinds().map(quickStart)}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted">
          <LayoutGrid className="h-4 w-4" aria-hidden />
          <span className="text-sm font-medium">{t(locale, "templates")}</span>
        </div>
        <Link
          href={`${pathname}/templates`}
          className="focus-ring rounded-sm text-sm font-medium text-muted u-colors hover:text-fg"
        >
          {t(locale, "library")}
        </Link>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {GALLERY_TEMPLATES.map(templateCard)}
        {loadState === "loading" &&
          Array.from({ length: GALLERY_TEMPLATE_SKELETONS }, (_, index) => (
            <Skeleton key={`tpl-skeleton-${index}`} variant="card" />
          ))}
        {loadState === "error" && (
          <Card variant="flat" padding="md" className="flex flex-col items-start gap-3">
            <p className="text-sm text-danger" role="alert">
              {t(locale, "somethingWentWrong")}
            </p>
            <Button size="sm" variant="secondary" onClick={loadTemplates}>
              {t(locale, "retry")}
            </Button>
          </Card>
        )}
        {loadState === "ready" && workspaceTemplates.map(workspaceCard)}
      </div>

      <Button
        variant="ghost"
        size="sm"
        aria-expanded={showOther}
        onClick={() => setShowOther((value) => !value)}
        className="mt-6 -ms-3 text-muted"
      >
        {t(locale, "otherTemplates")}
      </Button>

      {showOther && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OTHER_TEMPLATES.map((template) => (
            <Card
              key={template.id}
              as="button"
              type="button"
              variant="interactive"
              padding="md"
              aria-label={template.label}
              aria-disabled={pending || undefined}
              onClick={() => {
                if (pending) return;
                run(() => createBlockTemplateAction({ workspaceId, templateId: template.id }));
              }}
              className={GALLERY_CARD_STATE}
            >
              <Sparkles className="mb-1 h-4 w-4 text-muted" aria-hidden />
              <p className="text-sm font-medium text-fg">{template.label}</p>
              <p className="text-xs text-muted">{template.hint}</p>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-8 flex items-center gap-1.5 text-xs text-muted">
        <Users className="h-3.5 w-3.5" aria-hidden />
        {t(locale, "homeFooterA")} {workspaceName} {t(locale, "homeFooterB")}
      </p>
    </div>
  );
}
