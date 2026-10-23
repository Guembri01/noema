"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The slice of y-protocols Awareness the diagram canvas needs. */
export type DiagramAwareness = {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
  on(event: "change", handler: () => void): void;
  off(event: "change", handler: () => void): void;
};

const DiagramPresenceContext = createContext<DiagramAwareness | null>(null);

export function DiagramPresenceProvider({
  awareness,
  children,
}: {
  awareness: DiagramAwareness | null | undefined;
  children: ReactNode;
}) {
  return (
    <DiagramPresenceContext.Provider value={awareness ?? null}>
      {children}
    </DiagramPresenceContext.Provider>
  );
}

export function useDiagramPresence(): DiagramAwareness | null {
  return useContext(DiagramPresenceContext);
}
