"use client";

import { useEffect, useRef, useState } from "react";
import { AtSign, FileText, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import {
  commentMentionSearchAction,
  type CommentMentionSuggestion,
} from "@/server/actions/mentions";
import { commentMentionToken } from "@/lib/comment-body";
import { DOCUMENT_ATTACHMENT_ACCEPT } from "@/lib/file-type";
import { uploadFile } from "@/lib/upload-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Documents, spreadsheets and archives the attach control accepts. */
export const COMMENT_ATTACHMENT_ACCEPT = DOCUMENT_ATTACHMENT_ACCEPT;

const GLYPH: Record<CommentMentionSuggestion["type"], string> = {
  page: "📄",
  user: "👤",
  project: "📁",
  milestone: "🎯",
};

/**
 * The attach + mention controls shared by page and ticket comment composers.
 *
 * Attachments are uploaded through the normal asset route and inserted into
 * the comment body as a file link, so a comment can carry a spreadsheet or PDF
 * without a schema change. Mentions insert the same typed token the renderer
 * understands (`@[Label](project:<id>)`), which is what makes the resulting
 * chip navigable.
 */
export function CommentComposerTools({
  workspaceId,
  onInsert,
  disabled = false,
  compact = false,
}: {
  workspaceId?: string;
  onInsert: (text: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CommentMentionSuggestion[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!mentionOpen || !workspaceId) return;
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      commentMentionSearchAction(workspaceId, query)
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mentionOpen, query, workspaceId]);

  const attach = async (file: File) => {
    if (!workspaceId) return;
    setUploading(true);
    try {
      const asset = await uploadFile(file, workspaceId);
      onInsert(`📎 ${asset.name}\n${asset.url}\n`);
      toast.success(`${asset.name} attached`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not attach that file.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <span className="flex items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept={COMMENT_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void attach(file);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size={compact ? "xs" : "sm"}
        leftIcon={
          uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
          )
        }
        aria-label="Attach a document"
        title="Attach a document"
        disabled={disabled || uploading || !workspaceId}
        onClick={() => inputRef.current?.click()}
      >
        {compact ? null : "Attach"}
      </Button>

      <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={compact ? "xs" : "sm"}
            leftIcon={<AtSign className="h-3.5 w-3.5" aria-hidden />}
            aria-label="Mention a page, note, project or milestone"
            title="Mention a page, note, project or milestone"
            disabled={disabled || !workspaceId}
          >
            {compact ? null : "Mention"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-2" align="start">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, notes, projects, milestones"
            aria-label="Search mention targets"
            className="mb-2"
          />
          <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Mentions">
            {searching ? (
              <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Searching…
              </p>
            ) : results.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted">Nothing to mention yet.</p>
            ) : (
              results.map((result) => (
                <button
                  key={`${result.type}:${result.projectId ?? ""}:${result.id}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="focus-ring u-colors flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => {
                    onInsert(`${commentMentionToken(result)} `);
                    setMentionOpen(false);
                    setQuery("");
                  }}
                >
                  <span aria-hidden>{result.icon ?? GLYPH[result.type]}</span>
                  <span className="min-w-0 flex-1 truncate">{result.label}</span>
                  <span className="text-2xs uppercase tracking-wide text-muted">
                    {result.type}
                  </span>
                </button>
              ))
            )}
          </div>
          <p className="mt-2 flex items-center gap-1 border-t border-border px-1 pt-2 text-2xs text-muted">
            <FileText className="h-3 w-3" aria-hidden />
            Attachments keep the original file; links open in a new tab.
          </p>
        </PopoverContent>
      </Popover>
    </span>
  );
}
