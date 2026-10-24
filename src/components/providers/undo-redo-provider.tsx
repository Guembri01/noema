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
  historyView,
  mergeRemote as engineMergeRemote,
  nextRedoCommand,
  nextUndoCommand,
  push as enginePush,
  redo as engineRedo,
  redoTo as engineRedoTo,
  undo as engineUndo,
  undoTo as engineUndoTo,
  type Command,
  type HistoryEntry,
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
  /** The actual stack, oldest first — what the history surface renders. */
  history: HistoryEntry[];
  undo(): void;
  redo(): void;
  /**
   * Undo every local step down to (and including) `history[index]`. The row's
   * index comes straight from {@link history}; remote/undone rows are no-ops.
   */
  undoTo(index: number): void;
  /** Redo every local step up to (and including) `history[index]`. */
  redoTo(index: number): void;
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
  history: [],
  undo() {
    /* not mounted */
  },
  redo() {
    /* not mounted */
  },
  undoTo() {
    /* not mounted */
  },
  redoTo() {
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

/**
 * Run a transition's server effects in order. Undo effects arrive newest-first
 * and redo effects oldest-first from the pure engine, so awaiting them here is
 * what keeps a multi-step history click from racing its own writes. A failed
 * effect must not brick the stack — the in-memory history already moved, and
 * the next undo/redo can still try.
 */
async function runEffects(
  commands: readonly GlobalCommand[],
  direction: "undo" | "redo",
): Promise<void> {
  for (const command of commands) {
    const effect = direction === "undo" ? command.onUndo : command.onRedo;
    if (!effect) continue;
    try {
      await effect();
    } catch {
      // Keep walking: the stack is the source of truth, and one failed write
      // should not leave the remainder of a bulk inverse unapplied.
    }
  }
}

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
  const undoTo = useCallback(
    (index: number) => {
      const transition = engineUndoTo(stack, index);
      if (transition.commands.length === 0) return;
      setStack(transition.stack);
      void runEffects(transition.commands, "undo");
    },
    [stack],
  );
  const redoTo = useCallback(
    (index: number) => {
      const transition = engineRedoTo(stack, index);
      if (transition.commands.length === 0) return;
      setStack(transition.stack);
      void runEffects(transition.commands, "redo");
    },
    [stack],
  );
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
  const history = useMemo<HistoryEntry[]>(
    () => historyView(stack).entries,
    [stack],
  );

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
      history,
      undo,
      redo,
      undoTo,
      redoTo,
      push,
      mergeRemote,
      clear,
    }),
    [
      canUndo,
      canRedo,
      stack.state,
      history,
      undo,
      redo,
      undoTo,
      redoTo,
      push,
      mergeRemote,
      clear,
    ],
  );

  return (
    <UndoRedoContext.Provider value={value}>{children}</UndoRedoContext.Provider>
  );
}

/** Read the global undo/redo handle. Inert when no provider is mounted. */
export function useUndoRedo(): UndoRedoApi {
  return useContext(UndoRedoContext) ?? DETACHED;
}
