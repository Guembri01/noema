import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getPageTree, getWorkspaceBySlug } from "@/server/queries";

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

  const tree = await getPageTree(workspace.id);
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
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {nodes.map((node) => (
            <li key={node.id}>
              <Link
                href={`/w/${workspace.slug}/${node.id}`}
                className="flex h-full items-start gap-3 rounded-xl border border-border p-4 transition hover:bg-surface-2"
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
    <div className="mx-auto max-w-5xl px-8 py-12">
      <p className="text-sm text-muted">Workspace</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Library</h1>
      <p className="mt-2 text-sm text-muted">
        Everything in {workspace.name}, {tree.length} item
        {tree.length === 1 ? "" : "s"}.
      </p>
      {section("Databases", databases, "No databases yet.")}
      {section("Pages", pages, "No pages yet.")}
    </div>
  );
}
