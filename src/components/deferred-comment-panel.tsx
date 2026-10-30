"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";

type CommentPanelProps = ComponentProps<
  typeof import("@/components/comment-panel").CommentPanel
>;

const CommentPanel = dynamic(
  () =>
    import("@/components/comment-panel").then((mod) => ({
      default: mod.CommentPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <div aria-busy="true" className="space-y-2 p-4">
        <Skeleton variant="block" className="h-5 w-32" />
        <Skeleton variant="block" className="h-16 w-full" />
      </div>
    ),
  },
);

export function DeferredCommentPanel(props: CommentPanelProps) {
  // Mount immediately rather than waiting for the viewport. The editor's
  // "Comment" action dispatches a window event that the panel must already be
  // listening for; a below-the-fold panel used to miss that event entirely and
  // the selected quote was silently dropped.
  return <CommentPanel {...props} />;
}
