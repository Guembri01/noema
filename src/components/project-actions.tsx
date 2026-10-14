"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Mail, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createPageAction } from "@/server/actions/pages";
import { sendWorkspaceInviteAction } from "@/server/actions/email";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

/**
 * Project actions: start a note that belongs to the project, and invite an
 * external client to it (view-only guest, scoped to this project).
 */
export function ProjectActions({
  workspaceId,
  workspaceSlug,
  projectId,
  projectName,
  locale,
}: {
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
  projectName: string;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);

  const addNote = () =>
    startTransition(async () => {
      const outcome = await safeAction(() =>
        createPageAction({
          workspaceId,
          title: `${projectName} note`,
          projectId,
        }),
      );
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      toast.success(t(locale, "noteAddedToProject"));
      router.push(`/w/${workspaceSlug}/${value.id}`);
      router.refresh();
    });

  const invite = () =>
    startTransition(async () => {
      const outcome = await safeAction(() =>
        sendWorkspaceInviteAction({
          workspaceId,
          email,
          role: "GUEST",
          projectId,
        }),
      );
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      setEmail("");
      setLink(value.link);
      void navigator.clipboard?.writeText(value.link).catch(() => undefined);
      toast.success(
        value.emailed
          ? `${t(locale, "clientInvitedTo")} ${projectName}`
          : t(locale, "linkCopiedNoEmail"),
      );
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={addNote}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          <FilePlus2 className="h-4 w-4" /> {t(locale, "newNoteInProject")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setInviteOpen((value) => !value)}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          <UserPlus className="h-4 w-4" /> {t(locale, "inviteAClient")}
        </button>
      </div>

      {inviteOpen && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Mail className="h-4 w-4" /> {t(locale, "clientAccessTo")} {projectName}
          </p>
          <p className="mb-2 text-xs text-muted">
            {t(locale, "clientInviteIntro")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={email}
              aria-label={t(locale, "clientEmailAria")}
              placeholder="client@company.com"
              onChange={(event) => setEmail(event.target.value)}
              className="h-9 w-64 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={pending || !email.trim()}
              onClick={invite}
              className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
            >
              {t(locale, "sendInvitation")}
            </button>
          </div>
          {link && <p className="mt-2 truncate text-xs text-muted">{link}</p>}
        </div>
      )}
    </div>
  );
}
