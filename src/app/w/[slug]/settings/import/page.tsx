import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { ImportCenter } from "@/components/import-center";
import { Section } from "@/components/ui/section";
import { t } from "@/lib/i18n";
import { SettingsNav } from "../settings-nav";

/** Settings → Import (`/w/[slug]/settings/import`). */
export default async function ImportSettingsPage({
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
  const locale = user.locale ?? "en";

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link
        href={`/w/${workspace.slug}/settings`}
        className="focus-ring rounded-sm text-xs text-muted hover:underline"
      >
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">Import</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted">
        Bring pages, databases and notes in from another tool. Imported pages
        appear in the sidebar like any other page.
      </p>

      <SettingsNav slug={workspace.slug} locale={locale} className="mb-8" />

      <Section title="Choose a source">
        <ImportCenter
          workspace={{ id: workspace.id, slug: workspace.slug }}
          locale={locale}
        />
      </Section>
    </div>
  );
}
