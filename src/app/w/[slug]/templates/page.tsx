import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, LayoutGrid } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import {
  applyWorkspaceTemplateFormAction,
  listWorkspaceTemplatesAction,
  manageWorkspaceTemplateAction,
} from "@/server/actions/home-templates";
import {
  describeTemplate,
  previewTemplate,
  type PageTemplate,
  type TemplateSortKey,
} from "@/lib/template-gallery";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata = { title: "Templates" };

const SORTS: TemplateSortKey[] = ["relevance", "name", "created", "updated", "usage"];

function normalizeSort(value: string | undefined): TemplateSortKey {
  return SORTS.find((sort) => sort === value) ?? "name";
}

/**
 * The workspace template gallery (R31.7/R31.12/R31.15). It projects every row
 * template of the workspace's databases onto `@/lib/template-gallery`'s
 * `PageTemplate` model, then lists/searches/ranks/sorts/groups through that
 * module. Lifecycle controls post to `manageWorkspaceTemplateAction`, which
 * defers every invariant to `@/lib/database-template-engine`.
 */
export default async function TemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const { slug } = await params;
  const { q, sort } = await searchParams;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  const locale = user.locale ?? "en";

  const result = await listWorkspaceTemplatesAction({
    workspaceId: workspace.id,
    query: q,
    sort: normalizeSort(sort),
  });
  if (!("ok" in result)) notFound();

  const { groups, templates, defaultTemplateId } = result;

  const card = (template: PageTemplate) => {
    const preview = previewTemplate(template, { maxBlocks: 3 });
    const isDefault = template.id === defaultTemplateId;
    return (
      <li
        key={template.id}
        className="flex flex-col gap-3 rounded-xl border border-border p-4"
        data-default={isDefault ? "true" : undefined}
      >
        <div className="flex items-start gap-3">
          <span className="text-lg" aria-hidden>
            {template.icon ?? "📄"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{template.name}</p>
            <p className="truncate text-xs text-muted">{describeTemplate(template)}</p>
          </div>
          {isDefault ? (
            <span className="text-sm" aria-hidden>
              ★
            </span>
          ) : null}
        </div>

        {preview.entries.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-muted">
            {preview.entries.map((entry, index) => (
              <li key={index} className="truncate">
                <span className="uppercase tracking-wide opacity-60">{entry.type}</span>{" "}
                {entry.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">{t(locale, "noResults")}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <form action={applyWorkspaceTemplateFormAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="templateId" value={template.id} />
            <button
              type="submit"
              aria-label={t(locale, "apply")}
              className="focus-ring u-interactive rounded-md border border-border px-2 py-1 text-xs font-medium transition hover:bg-surface-2"
            >
              {t(locale, "apply")}
            </button>
          </form>

          <form action={manageWorkspaceTemplateAction} className="flex items-center gap-1">
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="op" value="rename" />
            <input
              type="text"
              name="name"
              defaultValue={template.name}
              aria-label={t(locale, "rename")}
              className="w-32 rounded-md border border-border px-2 py-1 text-xs"
            />
            <button
              type="submit"
              aria-label={t(locale, "save")}
              className="focus-ring u-interactive rounded-md border border-border px-2 py-1 text-xs transition hover:bg-surface-2"
            >
              {t(locale, "save")}
            </button>
          </form>

          <form action={manageWorkspaceTemplateAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="op" value="duplicate" />
            <button
              type="submit"
              aria-label={t(locale, "duplicate")}
              className="focus-ring u-interactive rounded-md border border-border px-2 py-1 text-xs transition hover:bg-surface-2"
            >
              {t(locale, "duplicate")}
            </button>
          </form>

          <form action={manageWorkspaceTemplateAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="op" value={isDefault ? "clear-default" : "default"} />
            <button
              type="submit"
              aria-label={t(locale, "favorites")}
              title={t(locale, "favorites")}
              className="focus-ring u-interactive rounded-md border border-border px-2 py-1 text-xs transition hover:bg-surface-2"
            >
              {isDefault ? "★" : "☆"}
            </button>
          </form>

          <form action={manageWorkspaceTemplateAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="op" value="move-up" />
            <button
              type="submit"
              aria-label={`${t(locale, "sort")} ↑`}
              className="focus-ring u-interactive rounded-md border border-border px-2 py-1 text-xs transition hover:bg-surface-2"
            >
              ↑
            </button>
          </form>
          <form action={manageWorkspaceTemplateAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="templateId" value={template.id} />
            <input type="hidden" name="op" value="move-down" />
            <button
              type="submit"
              aria-label={`${t(locale, "sort")} ↓`}
              className="focus-ring u-interactive rounded-md border border-border px-2 py-1 text-xs transition hover:bg-surface-2"
            >
              ↓
            </button>
          </form>

          <Link
            href={`/w/${workspace.slug}/${template.sourcePageId}`}
            className="focus-ring rounded-sm text-xs text-muted underline-offset-2 hover:underline"
          >
            {t(locale, "open")}
          </Link>
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link
        href={`/w/${workspace.slug}`}
        className="focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted hover:text-fg"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> {t(locale, "home")}
      </Link>
      <header className="mb-6 mt-2">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{t(locale, "templates")}</h1>
        <p className="mt-2 text-sm text-muted">
          {workspace.name} · {templates.length}
        </p>
      </header>

      <form className="mt-6 flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder={t(locale, "search")}
          aria-label={t(locale, "search")}
          className="focus-ring w-56 rounded-md border border-border px-3 py-1.5 text-sm"
        />
        <label className="text-xs text-muted">
          {t(locale, "sort")}
          <select
            name="sort"
            defaultValue={normalizeSort(sort)}
            className="focus-ring ml-2 rounded-md border border-border px-2 py-1.5 text-sm"
          >
            {SORTS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          aria-label={t(locale, "search")}
          className="focus-ring u-interactive rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-2"
        >
          {t(locale, "search")}
        </button>
      </form>

      {templates.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={<LayoutGrid className="h-5 w-5" />}
          title={t(locale, "noResults")}
          description="Save a database row as a template to reuse it here."
          primaryAction={
            <Button asChild>
              <Link href={`/w/${workspace.slug}`}>Browse templates</Link>
            </Button>
          }
        />
      ) : (
        <div className="mt-8 space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
              {t(locale, "templates")} · {groups.workspace.length}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.workspace.map(card)}
            </ul>
          </section>
          {groups.personal.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
                {t(locale, "privatePages")} · {groups.personal.length}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {groups.personal.map(card)}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
