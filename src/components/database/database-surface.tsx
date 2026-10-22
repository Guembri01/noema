"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";

type DatabaseViewProps = ComponentProps<
  typeof import("@/components/database/database-view").DatabaseView
>;

function DatabaseViewFallback() {
  return (
    <div aria-busy="true" className="mt-4">
      <Skeleton variant="table" rows={8} cols={5} />
    </div>
  );
}

const DatabaseView = dynamic(
  () =>
    import("@/components/database/database-view").then((mod) => ({
      default: mod.DatabaseView,
    })),
  { ssr: false, loading: () => <DatabaseViewFallback /> },
);

/**
 * Light client boundary for a database page. The route imports this module
 * only; `DatabaseView` (and every view renderer it owns) stays in an async
 * chunk that an editor page never requests.
 */
export function DatabaseSurface(props: DatabaseViewProps) {
  return <DatabaseView {...props} />;
}
