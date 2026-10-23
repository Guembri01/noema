"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Mail, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createPageAction } from "@/server/actions/pages";
import { sendWorkspaceInviteAction } from "@/server/actions/email";
import { safeAction } from "@/lib/actions-client";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * Project actions: start a note that belongs to the project, and invite an
 * external client to it (view-only guest, scoped to this project).
 *
 * Both actions ride the design-system `Button`, so hover / focus-visible /
 * active / disabled / loading are the shared vocabulary rather than bespoke
 * classes, and every colour comes from a token.
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
        <Button
          type="button"
          variant="secondary"
          loading={pending}
          onClick={addNote}
          leftIcon={<FilePlus2 className="h-4 w-4" />}
        >
          {t(locale, "newNoteInProject")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          aria-expanded={inviteOpen}
          onClick={() => setInviteOpen((value) => !value)}
          leftIcon={<UserPlus className="h-4 w-4" />}
        >
          {t(locale, "inviteAClient")}
        </Button>
      </div>

      {inviteOpen && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Mail className="h-4 w-4" /> {t(locale, "clientAccessTo")} {projectName}
          </p>
          <p className="mb-2 text-xs text-muted">{t(locale, "clientInviteIntro")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={email}
              aria-label={t(locale, "clientEmailAria")}
              placeholder={t(locale, "clientEmailPlaceholder")}
              onChange={(event) => setEmail(event.target.value)}
              className="h-9 w-64 rounded-control border-control bg-bg px-2 text-sm outline-none focus-ring"
            />
            <Button
              type="button"
              disabled={pending || !email.trim()}
              onClick={invite}
            >
              {t(locale, "sendInvitation")}
            </Button>
          </div>
          {link && <p className="mt-2 truncate text-xs text-muted">{link}</p>}
        </div>
      )}
    </div>
  );
}
