/**
 * P2-T10 (M7) — the "New row" in-flight guard.
 *
 * The container's `addRow` used to wrap the create bare in a
 * `startTransition(async () => { … await createRowAction; router.refresh(); })`.
 * Transitions do not dedupe server actions, so a rapid double click fired the
 * action twice — two whole rows, or 2+N writes when a default template
 * prefilled cells. React state alone is too late for the second click of a
 * fast double click, so the slot is claimed synchronously in the ref first,
 * with the pending boolean wiring `disabled` + `aria-busy` onto all five
 * `onAddRow` button sites (toolbar + table/list/board/gallery empty states),
 * mirroring the form view's pending submit (`disabled={pending}
 * aria-busy={pending}` in `form-view.tsx`).
 *
 * Pure over the shared ref so the flow is unit-testable without a DOM
 * (`add-row-guard.m7.test.ts`): the first claim wins, claims while pending are
 * dropped, and `settleRowCreation` — wired into the transition task's
 * `finally` — always releases the slot, so a failed create never blocks retry.
 */

/** The shared single-flight slot (`useRef` in the component). */
export type InFlightRef = { current: boolean };

/** Wired to the React state that drives `disabled`/`aria-busy` on the buttons. */
export type OnPending = (pending: boolean) => void;

/**
 * Claim the single create slot. `true` starts the create (and raises the
 * pending flag for the cart); `false` means one is already in flight — the
 * caller's click is dropped instead of writing a duplicate row.
 */
export function claimRowCreation(ref: InFlightRef, onPending?: OnPending): boolean {
  if (ref.current) return false;
  ref.current = true;
  if (onPending) onPending(true);
  return true;
}

/**
 * Release the slot after the create settles. Called from the transition task's
 * `finally`, so it runs on success and failure alike: the buttons re-enable
 * and the next click is a fresh create (never a blocked retry).
 */
export function settleRowCreation(ref: InFlightRef, onPending?: OnPending): void {
  ref.current = false;
  if (onPending) onPending(false);
}
