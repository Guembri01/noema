"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { DeferredMount } from "@/components/deferred-mount";
import { Skeleton } from "@/components/ui/skeleton";

type CommentPanelProps = ComponentProps<
  typeof import("@/components/comment-panel").CommentPanel
>;

function CommentPanelFallback() {
  return (
    <div aria-hidden="true" className="space-y-2 p-4">
      <Skeleton variant="block" className="h-5 w-32" />
      <Skeleton variant="block" className="h-16 w-full" />
    </div>
  );
}

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
  return (
    <DeferredMount minHeight={320} fallback={<CommentPanelFallback />}>
      <CommentPanel {...props} />
    </DeferredMount>
  );
}
