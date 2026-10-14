"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Database as DatabaseIcon, Upload } from "lucide-react";
import {
  importDocxAction,
  importMarkdownAction,
  importTrelloAction,
  importZipAction,
} from "@/server/actions/import";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { safeAction } from "@/lib/actions-client";

type StartTransition = (callback: () => void) => void;

type ImportSectionProps = {
  workspace: { id: string; slug: string };
  addPage: (parentId: string | null, type: "PAGE" | "DATABASE") => void;
  locale: string;
  startTransition: StartTransition;
  onOpenNotion: () => void;
};

export function ImportSection({
  workspace,
  addPage,
  locale,
  startTransition,
  onOpenNotion,
}: ImportSectionProps) {
  const router = useRouter();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      startTransition(async () => {
        const outcome = await safeAction(() =>
          importMarkdownAction({
            workspaceId: workspace.id,
            filename: file.name,
            markdown: String(reader.result ?? ""),
          }),
        );
        if (!outcome.ok) {
          toast.error(outcome.error);
          return;
        }
        const result = outcome.value;
        if ("ok" in result) {
          toast.success(`Imported ${file.name}`);
          router.push(`/w/${workspace.slug}/${result.id}`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    };
    reader.readAsText(file);
  };

  const trelloInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const onImportTrello = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      startTransition(async () => {
        const outcome = await safeAction(() =>
          importTrelloAction({ workspaceId: workspace.id, json: String(reader.result ?? "") }),
        );
        if (!outcome.ok) {
          toast.error(outcome.error);
          return;
        }
        const result = outcome.value;
        if ("ok" in result) {
          toast.success("Imported Trello board");
          router.push(`/w/${workspace.slug}/${result.id}`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    };
    reader.readAsText(file);
  };

  const onImportZip = (file: File) =>
    startTransition(async () => {
      const form = new FormData();
      form.append("workspaceId", workspace.id);
      form.append("file", file);
      const outcome = await safeAction(() => importZipAction(form));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success("Imported archive");
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const docxInputRef = useRef<HTMLInputElement | null>(null);

  const onImportDocx = (file: File) =>
    startTransition(async () => {
      const form = new FormData();
      form.append("workspaceId", workspace.id);
      form.append("file", file);
      const outcome = await safeAction(() => importDocxAction(form));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success("Imported Word document");
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const transcribeInputRef = useRef<HTMLInputElement | null>(null);

  const onTranscribe = (file: File) =>
    startTransition(async () => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/ai/transcribe", { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? `Transcription failed (${response.status})`);
        return;
      }
      const data = (await response.json()) as { text?: string };
      const outcome = await safeAction(() =>
        importMarkdownAction({
          workspaceId: workspace.id,
          filename: `${file.name.replace(/\.[^.]+$/, "")} (transcript)`,
          markdown: data.text ?? "",
        }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success("Transcript added");
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  return (
    <div className="mt-3 space-y-px border-t border-border pt-3">
      <button
        type="button"
        onClick={() => addPage(null, "DATABASE")}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <DatabaseIcon className="h-4 w-4" />
        {t(locale, "newDatabase")}
      </button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        {t(locale, "importMarkdown")}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportFile(file);
        }}
      />
      <button
        type="button"
        onClick={() => trelloInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Trello (JSON)
      </button>
      <input
        ref={trelloInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportTrello(file);
        }}
      />
      <button
        type="button"
        onClick={() => zipInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import export (.zip)
      </button>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportZip(file);
        }}
      />
      <button
        type="button"
        onClick={() => docxInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Word (.docx)
      </button>
      <input
        ref={docxInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportDocx(file);
        }}
      />
      <button
        type="button"
        onClick={onOpenNotion}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import from Notion (API)
      </button>
      <button
        type="button"
        onClick={() => transcribeInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Transcribe audio
      </button>
      <input
        ref={transcribeInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onTranscribe(file);
        }}
      />
    </div>
  );
}
