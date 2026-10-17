import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getPageTree, getUserWorkspaces, getWorkspaceBySlug } from "@/server/queries";
import type { PageTreeNode } from "@/server/queries";
import {
  executeWorkspaceMoveAction,
  previewWorkspaceMoveAction,
} from "@/server/actions/move-workspace";
import { Section } from "@/components/ui/section";
import { SettingsNav } from "../settings-nav";
import { t } from "@/lib/i18n";

export const metadata = { title: "Move pages" };

/**
 * Settings → Move pages (`/w/[slug]/settings/move`).
 *
 * The reachable entry point for the cross-workspace move feature. It is a thin
 * server shell: pick a source page (its whole subtree moves) and a destination
 * workspace the user belongs to, preview the pure plan (`@/lib/workspace-move`
 * wired through `previewWorkspaceMoveAction`), then confirm. The confirm posts
 * to an inline server action that re-plans and writes through
 * `executeWorkspaceMoveAction` — the preview is never trusted, and every
 * refusal is recomputed server-side.
 *
 * The selection is a plain GET form (no client component): the preview is a
 * re-render with `?source=&to=` search params, and the confirm is a POST.
 */
export default async function MovePagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ source?: string; to?: string; error?: string }>;
}) {
  const { slug } = await params;
  const { source, to, error } = await searchParams;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const [pages, allWorkspaces] = await Promise.all([
    getPageTree(workspace.id),
    getUserWorkspaces(user.id),
  ]);
  const destinations = allWorkspaces.filter((candidate) => candidate.id !== workspace.id);

  const byId = new Map(pages.map((page) => [page.id, page]));
  const depthOf = (page: PageTreeNode): number => {
    let depth = 0;
    let parent = page.parentId;
    const guard = new Set<string>();
    while (parent && !guard.has(parent)) {
      guard.add(parent);
      depth += 1;
      parent = byId.get(parent)?.parentId ?? null;
    }
    return depth;
  };

  const preview =
    source && to
      ? await previewWorkspaceMoveAction({ sourcePageId: source, targetWorkspaceId: to })
      : null;

  /** Confirm: re-plan server-side and write; redirect to the moved page. */
  async function confirmMove(formData: FormData) {
    "use server";
    const sourcePageId = String(formData.get("source") ?? "");
    const targetWorkspaceId = String(formData.get("to") ?? "");
    const result = await executeWorkspaceMoveAction({ sourcePageId, targetWorkspaceId });
    if ("ok" in result) {
      redirect(
        result.targetPageId
          ? `/w/${result.targetSlug}/${result.targetPageId}`
          : `/w/${result.targetSlug}`,
      );
    }
    redirect(
      `/w/${slug}/settings/move?source=${encodeURIComponent(sourcePageId)}&to=${encodeURIComponent(
        targetWorkspaceId,
      )}&error=${encodeURIComponent(result.error)}`,
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">
        Move pages to another workspace
      </h1>
      <p className="mb-6 text-sm text-muted">
        Choose a page; it and all of its descendants move. Internal links and embeds are
        rewritten, references that do not exist in the destination are dropped with a
        warning, and every warning is shown before you confirm.
      </p>

      <SettingsNav slug={workspace.slug} locale={locale} className="mb-8" />

      {error && (
        <p role="alert" className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <form method="GET" className="flex flex-wrap items-end gap-3" aria-label="Choose a move">
        <label className="flex min-w-56 flex-col gap-1 text-xs text-muted">
          Source page
          <select
            name="source"
            defaultValue={source ?? ""}
            className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
          >
            <option value="">Select a page…</option>
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {"\u00A0".repeat(depthOf(page) * 2)}
                {page.icon ? `${page.icon} ` : ""}
                {page.title || "Untitled"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-56 flex-col gap-1 text-xs text-muted">
          Destination workspace
          <select
            name="to"
            defaultValue={to ?? ""}
            className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
          >
            <option value="">Select a workspace…</option>
            {destinations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.icon ? `${candidate.icon} ` : ""}
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="inline-flex h-9 items-center rounded border border-border px-3 text-sm hover:bg-surface-2"
        >
          Preview
        </button>
      </form>

      {destinations.length === 0 && (
        <p className="mt-3 text-xs text-muted">
          You are not a member of any other workspace, so there is nowhere to move pages to.
        </p>
      )}

      {preview && !preview.ok && (
        <p role="alert" className="mt-6 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">
          {preview.error}
        </p>
      )}

      {preview && preview.ok && (
        <Section
          className="mt-8 rounded-lg border border-border p-4"
          aria-label="Move preview"
          title={
            <>
              {preview.sourcePageTitle || "Untitled"} → {preview.targetName}
            </>
          }
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Pages</dt>
              <dd className="tabular-nums">{preview.summary.pageCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">New top-level</dt>
              <dd className="tabular-nums">{preview.summary.rootIds.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Memberships queued</dt>
              <dd className="tabular-nums">{preview.summary.membershipCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Warnings</dt>
              <dd className="tabular-nums">{preview.summary.warningCount}</dd>
            </div>
          </dl>

          {!preview.access.allowed && (
            <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2">
              <p className="text-sm font-medium text-red-500">
                The destination workspace refuses this move
              </p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted">
                {preview.access.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {!preview.validation.ok && (
            <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2">
              <p className="text-sm font-medium text-red-500">The plan is not valid</p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted">
                {preview.validation.errors.map((planError) => (
                  <li key={planError}>{planError}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.collisions.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Title collisions ({preview.collisions.length})
              </h3>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {preview.collisions.map((collision) => (
                  <li key={`${collision.incomingId}-${collision.kind}-${collision.existingId}`}>
                    &ldquo;{collision.value}&rdquo; already matches a page in the destination —
                    the move is still allowed.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Warnings ({preview.warnings.length})
              </h3>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {preview.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.pageId ?? ""}-${warning.refId ?? ""}-${index}`}>
                    {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.canConfirm ? (
            <form action={confirmMove} className="mt-5">
              <input type="hidden" name="source" value={preview.sourcePageId} />
              <input type="hidden" name="to" value={preview.targetWorkspaceId} />
              <button
                type="submit"
                className="inline-flex h-9 items-center rounded bg-accent px-3 text-sm font-medium text-white hover:opacity-90"
              >
                Move {preview.summary.pageCount} page
                {preview.summary.pageCount === 1 ? "" : "s"} to {preview.targetName}
              </button>
            </form>
          ) : (
            <p className="mt-5 text-xs text-muted">
              This move cannot be confirmed until the refusals above are resolved.
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
