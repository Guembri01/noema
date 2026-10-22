"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { DeferredMount } from "@/components/deferred-mount";
import { Skeleton } from "@/components/ui/skeleton";

type BacklinksProps = ComponentProps<typeof import("@/components/backlinks").Backlinks>;

function BacklinksFallback() {
  return (
    <section aria-hidden="true" className="mt-12 space-y-2 border-t border-border pt-6">
      <Skeleton variant="block" className="h-4 w-36" />
      <Skeleton variant="block" className="h-4 w-2/3" />
    </section>
  );
}

const Backlinks = dynamic(
  () =>
    import("@/components/backlinks").then((mod) => ({
      default: mod.Backlinks,
    })),
  {
    ssr: false,
    loading: () => (
      <section aria-busy="true" className="mt-12 space-y-2 border-t border-border pt-6">
        <Skeleton variant="block" className="h-4 w-36" />
        <Skeleton variant="block" className="h-4 w-2/3" />
      </section>
    ),
  },
);

export function DeferredBacklinks(props: BacklinksProps) {
  return (
    <DeferredMount minHeight={160} fallback={<BacklinksFallback />}>
      <Backlinks {...props} />
    </DeferredMount>
  );
}
