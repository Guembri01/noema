import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { getPageTree, getWorkspaceBySlug } from "@/server/queries";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata = { title: "Library" };

/** The workspace library: every page and database in one browsable grid. */
export default async function LibraryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  // Guests only see the pages that were shared with them.
  const visiblePageIds = await pageScopeFor(user.id, workspace.id, access.role);

  const tree = await getPageTree(workspace.id, visiblePageIds);
  const databases = tree.filter((node) => node.type === "DATABASE");
  const pages = tree.filter((node) => node.type === "PAGE");
  const titles = new Map(tree.map((node) => [node.id, node.title]));

  const section = (
    label: string,
    nodes: typeof tree,
    empty: string,
  ) => (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
        {label} · {nodes.length}
      </h2>
      {nodes.length === 0 ? (
        <EmptyState variant="compact" title={empty} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {nodes.map((node) => (
            <li key={node.id}>
              <Link
                href={`/w/${workspace.slug}/${node.id}`}
                className="flex h-full items-start gap-3 rounded-lg border border-border p-4 transition hover:bg-surface-2"
              >
                <span className="text-lg" aria-hidden>
                  {node.icon ?? (node.type === "DATABASE" ? "🗂️" : "📄")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {node.title || "Untitled"}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {node.parentId
                      ? titles.get(node.parentId) || "Nested page"
                      : "Top level"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <header className="mb-6">
        <p className="text-sm text-muted">Workspace</p>
        <h1 className="mt-1 text-title font-semibold tracking-title">Library</h1>
        <p className="mt-2 text-sm text-muted">
          Everything in {workspace.name}, {tree.length} item
          {tree.length === 1 ? "" : "s"}.
        </p>
      </header>

      {tree.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="Nothing in this workspace yet"
          description="Create a page or a database to start building your library."
          primaryAction={
            <Button asChild>
              <Link href={`/w/${workspace.slug}`}>Create content</Link>
            </Button>
          }
        />
      ) : (
        <>
          {section("Databases", databases, "No databases yet.")}
          {section("Pages", pages, "No pages yet.")}
        </>
      )}
    </div>
  );
}
