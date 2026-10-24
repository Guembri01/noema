"use client";

/**
 * Global undo/redo provider (docs/FEATURE_MATRIX.md §16 "Undo/redo (global)",
 * MISSING_FEATURES gap #13; engine in `src/lib/undo-redo.ts`).
 *
 * Mounts exactly one {@link createUndoStack} engine for the whole app and
 * publishes it through context, so any surface can record an invertible command
 * and every surface sees the same history. The provider also owns the keyboard
 * shortcuts (`Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` redo) and
 * exposes the controls (`undo`/`redo`/`canUndo`/`canRedo`) the topbar renders.
 *
 * The engine is the single source of truth for history semantics — this file
 * only threads React state through it and maps keydowns to actions. `shortcutFor`
 * is deliberately pure and DOM-free so the mapping is provable in isolation.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  canRedo as engineCanRedo,
  canUndo as engineCanUndo,
  clear as engineClear,
  createUndoStack,
  mergeRemote as engineMergeRemote,
  nextRedoCommand,
  nextUndoCommand,
  push as enginePush,
  redo as engineRedo,
  undo as engineUndo,
  type Command,
  type UndoStack,
} from "@/lib/undo-redo";

/** The threaded state the global history operates on. */
export type GlobalUndoState = Record<string, unknown>;

/** A command recorded with the global stack. */
export type GlobalCommand = Command<GlobalUndoState>;

/** The subset of a `KeyboardEvent` {@link shortcutFor} reads. */
export type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** The history action a keydown requests. */
export type UndoShortcut = "undo" | "redo";

/**
 * Pure: map a keydown to a history action, or `null` when it is not one.
 *
 * `Ctrl/Cmd+Z` undoes; `Ctrl/Cmd+Shift+Z` and `Ctrl+Y` redo. Alt-modified
 * chords are left to the OS/browser, and an unmodified key is never ours.
 */
export function shortcutFor(event: ShortcutEvent): UndoShortcut | null {
  if (event.altKey) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return null;
}

/** The handle every consumer receives from {@link useUndoRedo}. */
export type UndoRedoApi = {
  canUndo: boolean;
  canRedo: boolean;
  /** The present state with every applied command folded in, oldest first. */
  state: GlobalUndoState;
  undo(): void;
  redo(): void;
  /** Record a local, invertible command and advance the state. */
  push(command: GlobalCommand): void;
  /** Fold in a collaborator's command (outside the local undo scope). */
  mergeRemote(command: GlobalCommand): void;
  /** Empty the history, keeping the present state. */
  clear(): void;
};

/**
 * Returned by {@link useUndoRedo} when there is no provider above the caller.
 * A disabled, inert handle keeps the consumer render-safe instead of throwing;
 * the real handle is always present under the app shell's root layout.
 */
const DETACHED: UndoRedoApi = {
  canUndo: false,
  canRedo: false,
  state: {},
  undo() {
    /* not mounted */
  },
  redo() {
    /* not mounted */
  },
  push() {
    /* not mounted */
  },
  mergeRemote() {
    /* not mounted */
  },
  clear() {
    /* not mounted */
  },
};

const UndoRedoContext = createContext<UndoRedoApi | null>(null);

export function UndoRedoProvider({
  children,
  limit,
}: {
  children: React.ReactNode;
  limit?: number;
}) {
  const [stack, setStack] = useState<UndoStack<GlobalUndoState>>(() =>
    createUndoStack<GlobalUndoState>({ state: {}, limit }),
  );

  const undo = useCallback(() => {
    const command = nextUndoCommand(stack);
    setStack((current) => engineUndo(current));
    if (command?.onUndo) {
      void Promise.resolve(command.onUndo()).catch(() => undefined);
    }
  }, [stack]);
  const redo = useCallback(() => {
    const command = nextRedoCommand(stack);
    setStack((current) => engineRedo(current));
    if (command?.onRedo) {
      void Promise.resolve(command.onRedo()).catch(() => undefined);
    }
  }, [stack]);
  const push = useCallback(
    (command: GlobalCommand) => setStack((current) => enginePush(current, command)),
    [],
  );
  const mergeRemote = useCallback(
    (command: GlobalCommand) =>
      setStack((current) => engineMergeRemote(current, command)),
    [],
  );
  const clear = useCallback(() => setStack((current) => engineClear(current)), []);

  const canUndo = engineCanUndo(stack);
  const canRedo = engineCanRedo(stack);

  // Global shortcuts. An editable target (input, textarea, select,
  // contenteditable — e.g. the editor) keeps its own history, so we never
  // hijack it; and we only consume a chord the stack can actually service.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = shortcutFor(event);
      if (action === null) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (action === "undo") {
        if (!canUndo) return;
        event.preventDefault();
        undo();
      } else {
        if (!canRedo) return;
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canUndo, canRedo, undo, redo]);

  const value = useMemo<UndoRedoApi>(
    () => ({
      canUndo,
      canRedo,
      state: stack.state,
      undo,
      redo,
      push,
      mergeRemote,
      clear,
    }),
    [canUndo, canRedo, stack.state, undo, redo, push, mergeRemote, clear],
  );

  return (
    <UndoRedoContext.Provider value={value}>{children}</UndoRedoContext.Provider>
  );
}

/** Read the global undo/redo handle. Inert when no provider is mounted. */
export function useUndoRedo(): UndoRedoApi {
  return useContext(UndoRedoContext) ?? DETACHED;
}
