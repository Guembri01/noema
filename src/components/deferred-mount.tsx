"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mount `children` when the placeholder is within one viewport of the reader.
 *
 * The SSR pass always renders `fallback`: a panel below the editor must not be
 * part of the server's client-chunk graph, and the placeholder keeps the page
 * height stable until the real panel takes over.
 */
export function DeferredMount({
  children,
  fallback,
  minHeight = 240,
  rootMargin = "600px 0px",
}: {
  children: ReactNode;
  fallback: ReactNode;
  minHeight?: number;
  rootMargin?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || mounted) return;

    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setMounted(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [mounted, rootMargin]);

  return (
    <div ref={ref} style={mounted ? undefined : { minHeight }}>
      {mounted ? children : fallback}
    </div>
  );
}
