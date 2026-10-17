# Noema — Design System

The one place that defines *how things look and move*. Every component follows it;
`check:coherence`, `src/lib/design-tokens.test.ts` and `npm run design:report`
stop it from drifting.

> Feature-by-feature status and the remaining work live in
> [`FRONTEND_PLAN.md`](./FRONTEND_PLAN.md). The primitive inventory is in §11.

---

## 1. The four rules

1. **Colour** always comes from a token: `bg-surface-2`, `text-muted`, `border-border-strong`, `text-danger`.
   Never a raw hex in a component (`#eee`, `rgb(...)`) — only in `globals.css` / `tokens.css`, where the tokens are declared.
2. **Motion** always comes from a duration + easing token: `u-colors`, `animate-rise`, `DUR.base`.
   Never `transition: all .3s` and never an ad-hoc millisecond value.
3. **Layering** always comes from `Z.*` / `--z-*`. Never an arbitrary z-index.
4. **Shape** (radius, shadow, spacing) comes from the scale. Never a bespoke radius or shadow.

---

## 2. Colour tokens

| Purpose | Tokens |
|---|---|
| Page / chrome | `bg` `sidebar` `surface` `surface-2` `surface-3` |
| Lines | `border` (hairline) · `border-strong` (dividers, scrollbar thumb) |
| Text | `fg` (primary) · `fg-subtle` (tertiary) · `muted` (secondary) |
| Brand | `accent` `accent-fg` `accent-soft` `ring` `selection` |
| Status | `danger` `danger-fg` `danger-soft` · `success` `success-soft` · `warning` `warning-soft` · `overlay` |
| Tags | `--tag-{gray,brown,orange,yellow,green,blue,purple,pink,red,teal}-{fg,bg,bd}` |

Every token is defined three times: light (`:root`), dark (`.dark`), and
high-contrast (`[data-contrast="more"]` + `.dark [data-contrast="more"]`). **A new
token must be added to all of them** — that is the first thing a reviewer checks.

Usage:
```tsx
<span className="text-muted">…</span>
<div className="border-b border-border bg-surface-2" />
<span className="tag" style={tagStyle("blue")}>Done</span>
```

## 3. Typography

| Role | Class | Size / line-height |
|---|---|---|
| Dense chrome (kbd, count badges) | `text-3xs` | 10 / 12 |
| Metadata, captions | `text-2xs` | 11 / 14 |
| Micro (kbd, badges) | `text-xs` | 12 / 16 |
| Secondary body copy | `text-md` | 13 / 20 |
| UI (menus, cells, labels) | `text-sm` | 13–14 / 20 |
| Prose (editor body) | `text-base` | 16 / 26 |
| Section title | `text-xl font-semibold tracking-[-0.01em]` | 20 |
| Page title / page heading | `text-title font-semibold tracking-title` | 28 / 1.2 |

Rules: **never** invent a size; headings use tighter tracking, body never. Numbers in
tables use `tabular-nums`. Truncate rows with `truncate` + a `title` attribute.

`text-title` + `tracking-title` are tokens (`--text-title`, `--tracking-title`) for the
same reason the small steps are: twelve surfaces wrote the identical pair as arbitrary
values, which is a token waiting to be named rather than twelve coincidences. A user
*heading* uses them; a *section* title inside a panel uses `text-xl`.

## 4. Spacing & layout

4 px grid (`p-1` = 4 px). Rhythm inside a panel: `gap-2` between controls, `gap-6`
between sections, `py-12 px-8` for a page container (`max-w-[1600px]`, full-bleed).
Density is user-selectable later; today the default is comfortable.

## 5. Shape & elevation

| Token | Value | Used for |
|---|---|---|
| `rounded-xs` | 3 px | chips, kbd |
| `rounded-sm` | 4 px | buttons, inputs, cells |
| `rounded-md` | 6 px | cards, menus |
| `rounded-lg` | 10 px | popovers, panels, modals |
| `rounded-xl` | 14 px | large sheets |
| `shadow-1` | — | raised cards |
| `shadow-2` | — | popovers / menus (`.surface-raised`) |
| `shadow-3` | — | modals (`.surface-raised-strong`) |
| `shadow-focus` | — | the focus ring |

## 6. Motion vocabulary

| Token | Duration | Used for |
|---|---|---|
| `--dur-1` / `DUR.fast` | 120 ms | hover, press, colour, small fades |
| `--dur-2` / `DUR.base` | 180 ms | menus, toggles, expand/collapse |
| `--dur-3` / `DUR.slow` | 240 ms | drawers, sheets, route content |
| `--dur-4` / `DUR.slower` | 320 ms | large surface enter |

Easings: `--ease-smooth` (default), `--ease-in-out-soft`, `--ease-spring` (popovers,
drag settle).

Named animations: `animate-rise` (menus), `animate-fade`, `animate-scale-in`
(dialogs), `animate-slide-in-right` (right drawers), `animate-slide-in-left` /
`animate-slide-in-bottom` (peek panels and bottom sheets), `animate-spin`
(spinners / pending controls), `animate-shimmer` / `animate-sweep` (skeletons),
`animate-pulse-soft`.

Utility classes: `.u-colors`, `.u-transform`, `.u-surface`, `.u-interactive`
(hover + `:active` scale), `.focus-ring`, `.surface-raised`, `.surface-raised-strong`,
`.scrollbar-thin`, `.no-scrollbar`, `.edge-fade-t` / `.edge-fade-b` /
`.edge-fade-both` (scrolled-list masks), `.u-shimmer` (token-driven skeleton
sweep — preferred over the legacy `.notion-skeleton`), `.u-no-transition`.

The values live in `src/app/tokens.css` (`--dur-*`, `--ease-*`, keyframes) and
are mapped into Tailwind's `@theme` in `src/app/globals.css` (`--animate-*`), so
`animate-*` utilities and `DUR.*` always agree.

### Interaction rules (the "smooth" contract)
- Hover = background/border/colour change only, never size.
- Press = `scale(0.985)` on buttons/cards via `.u-interactive`.
- **Dragging is 1:1**: while a resizer or a drag is active the element must have
  **no transition** (add `.u-no-transition`), otherwise it lags the cursor.
- Blocks animate `height`+`opacity` on insert/remove (140–180 ms), never on scroll.
- `prefers-reduced-motion` neutralises everything globally — never bypass it.

## 7. Layering

`Z.sticky 10` → `Z.sidebar 30` → `Z.overlay 40` (scrims) → `Z.popover 50` →
`Z.modal 60` → `Z.toast 70` → `Z.tooltip 80` → `Z.drag 90`.

### 7.1 Floating placement — the one popup engine

A popup must **never** be clipped by the viewport, and must **never** position
itself with hand-rolled `top`/`left` maths. Every floating layer goes through
`src/lib/floating.ts` (pure, unit-tested in `floating.test.ts`):

```ts
placeFloating({ anchor, size, viewport, preferred, align, gap, padding }) → {
  top, left,            // clamped inside the viewport
  side,                 // the side actually used
  flipped,              // true when it moved to the opposite side
  cramped,             // true when the layer is taller than the space allows
  maxHeight,           // the largest height that fits (caller scrolls the rest)
}
```

- **Preferred side**: `preferred: "top" | "bottom" | "left" | "right"`.
- **Flip**: when the preferred side cannot fit and the opposite side is roomier,
  `side` becomes the opposite and `flipped` is `true`.
- **Align**: `align: "start" | "center" | "end"` positions the layer along the
  anchor's cross axis.
- **Clamp**: `top`/`left` are always kept inside the viewport by `padding`
  (`FLOATING_PADDING`, 8 px); `gap` (`FLOATING_GAP`, 4 px == `--space-1`) is the
  distance from the anchor.
- **maxHeight**: the layer is capped to the space on the chosen side; a `cramped`
  layer scrolls its own overflow instead of overflowing the screen.
- `floatingStyle(placement)` returns the `{ position: "fixed", top, left, maxHeight }`
  inline style for the DOM.

Used by the hand-rolled popups: the `Select` listbox (`ui/select.tsx`), the
inline `/` slash menu (`editor/slash-menu.tsx`) and the topbar actions menu +
submenus (`topbar/actions-menu.tsx`).

The Radix-based surfaces (`DropdownMenu`, `Popover`, `ContextMenu`, `Dialog`,
`Sheet`) delegate the same flip + shift + clamp to Radix's popper, configured
with `OVERLAY_COLLISION_PADDING` (8 px) and `OVERLAY_SIDE_OFFSET` (6 px);
`resolveFloatingPlacement` in `ui/dropdown-menu.tsx` is the DOM-free spec of that
behaviour, pinned by `dropdown-menu.test.ts`. New *custom* popups must use
`src/lib/floating.ts` — do not add a third implementation.

## 8. States — every interactive element needs all of them

`default` · `hover` · `focus-visible` (`.focus-ring`) · `active` · `disabled`
(`opacity-50 cursor-not-allowed`) · `loading` (spinner, button disabled, no layout
shift) · `error` (danger ring + message below).

Every **list/panel** needs: `loading` (skeleton matching the final layout),
`empty` (icon + title + hint + primary action), `error` (message + retry).

## 9. Accessibility baseline

Focus ring on everything focusable; focus trapped in overlays; `aria-label` on
icon-only buttons; live regions for async results; 44 px minimum touch targets on
mobile; contrast AA for every token pair (tags included); RTL-safe logical CSS
(`ms-*`/`me-*`, no `left/right` for direction-dependent layout).

## 10. Checklist before you call a component "done"

- [ ] **No raw hex** (`#…`, `rgb(…)`, `hsl(…)`) outside `globals.css` / `tokens.css`
      — including user-chosen colours, which go through a token or `tagStyle()`.
- [ ] **No magic z-index** — `Z.*` / `--z-*` only, never a hard-coded z-index.
- [ ] **No ad-hoc duration** — `DUR.*` / `--dur-*` only, never an ad-hoc duration
      or `transition: all .3s`.
- [ ] No arbitrary radius/shadow (`rounded-[7px]`, a bespoke shadow); shape comes from
      the scales in §5.
- [ ] All seven states implemented (see §8).
- [ ] Any popup goes through `src/lib/floating.ts` (§7.1) — never hand-rolled
      `top`/`left`.
- [ ] Keyboard path exists for every pointer path.
- [ ] Works in light, dark and high-contrast (screenshot each).
- [ ] Works at 320 px wide and 200 % zoom.
- [ ] Reduced motion verified.
- [ ] Strings ready for i18n (no concatenation of sentences).
- [ ] Has a node test for its pure mapping, an SSR render test where it renders
      markup, and appears in a live check.
- [ ] `npm run design:report` has not regressed (see `check:design` / the
      "how we verify design work" section in `FRONTEND_PLAN.md`).

---

## 11. UI primitives (the kit on disk)

Everything a screen reuses lives in `src/components/ui/`. Each has a companion
`*.test.ts` with the pure mapping pinned. Add to the kit instead of inventing a
one-off control.

| Group | Primitives | File |
|---|---|---|
| Buttons | `Button` (solid/soft × primary/secondary/ghost/danger; sm/md/lg; `loading`; `iconOnly`) | `ui/button.tsx` |
| Inputs | `Input`, `Textarea`, `Field` (label + error + help) | `ui/input.tsx` |
| Toggles | `Checkbox` (tri-state), `Radio` / `RadioGroup`, `Switch` (optimistic) | `ui/checkbox.tsx`, `ui/radio.tsx`, `ui/switch.tsx` |
| Select | `Select` / combobox (single + multi, grouped, virtualized, tags, keyboard) | `ui/select.tsx` |
| Numeric | `Slider` (single + range), `Stepper` | `ui/slider.tsx`, `ui/stepper.tsx` |
| Choice views | `Segmented` (2–6 way sliding pill) | `ui/segmented.tsx` |
| Overlays | `DropdownMenu`, `ContextMenu`, `Popover`, `Tooltip`, `Dialog` + `DialogContent`, `ConfirmDialog` | `ui/dropdown-menu.tsx`, `ui/context-menu.tsx`, `ui/popover.tsx`, `ui/tooltip.tsx`, `ui/dialog.tsx`, `ui/confirm-dialog.tsx` |
| Panels | `Sheet` (left/right/bottom drawer, focus trap + scroll lock) | `ui/sheet.tsx` |
| Dates | `DatePicker` (date/range/time/datetime + presets), `CalendarGrid` | `ui/date-picker.tsx`, `ui/calendar-grid.tsx` |
| Picking | `EmojiPicker` (catalog + frecency) | `ui/emoji-picker.tsx` |
| Containers | `Card` (+ Media/Title/Description/Header/Body/Footer), `Section` (settings block) | `ui/card.tsx`, `ui/section.tsx` |
| Metadata | `Badge` (tones, count caps), `Tag` (selectable/removable + hues), `Avatar` / `AvatarGroup`, `Kbd` | `ui/badge.tsx`, `ui/tag.tsx`, `ui/avatar.tsx`, `ui/kbd.tsx` |
| Feedback | `EmptyState` (full/compact), `Skeleton`, `Spinner`, `Progress` / `ProgressRing`, `RouteProgress`, `Toaster` | `ui/empty-state.tsx`, `ui/skeleton.tsx`, `ui/spinner.tsx`, `ui/progress.tsx`, `ui/route-progress.tsx`, `ui/toaster.tsx` |
| Scrolling | `ScrollArea` (thin scrollbars + edge fades), `Separator` | `ui/scroll-area.tsx`, `ui/separator.tsx` |

Token values are exposed to TSX by `src/lib/design-tokens.ts` (`Z`, `DUR`, `EASE`,
`RADIUS`, `SHADOW`, `SPACE`, `BREAKPOINT`, `TAG_HUES`, `tagClass`, `tagStyle`).
Popup maths is in `src/lib/floating.ts` (§7.1).

---

## 12. Design-system status

Current `npm run design:report` (`scripts/check-design-system.mjs`) on this tree —
the numbers below are quoted verbatim and must never get worse (`check:design`
fails if any total exceeds its baseline):

| Rule | Found | Baseline |
|---|---|---|
| raw hex | 0 | 0 |
| arbitrary z-index | 0 | 0 |
| arbitrary duration | 0 | 0 |
| arbitrary radius | 0 | 0 |
| ad-hoc shadow | 0 | 0 |
| legacy palette | 0 | 0 |

**The whole app is on the system.** 171 files scanned, 0 with a hit, and every
baseline is now 0 — so the ratchet only turns one way: any new raw hex, magic
z-index, ad-hoc duration/radius/shadow or legacy palette class fails
`npm run check:design` in CI (`site.yml`).

`npm run audit:frontend` is the *classified* list of what a token cannot catch by
itself (copy, labels, type, rings, hand-rolled popups). It went from
**289 DEFECT / 190 INCONSISTENCY / 119 DEBT** to **0 / 0 / 113** as this wave landed:

| Rule | Before | Now |
|---|---|---|
| Untranslated user-facing copy | 243 | **0** |
| Icon-only controls with no accessible name | 46 | **0** |
| Type/spacing off the token scale | 127 | **0** |
| Buttons without the shared focus ring | 63 | **0** |
| Inline static styles | 8 | **0** |
| Routes with no `loading.tsx` | 12 | **0** |
| Legacy `.notion-*` / `.noema-*` rules | 95 | 95 — deliberate |
| Hand-rolled anchored popovers | 6 | 6 — 3 explained (absolute + static offsets) |
| Duplicated helpers / colour catalogues | 10 | 12 — the canonical catalogue is one of them |

The remaining DEBT is a documented backlog, not a defect list: every one of the 95
legacy rules is still referenced (deleting one is a visual regression — the families
that need them are recorded in `globals.css`), and the duplicate-helper heuristic
counts `src/lib/palette.ts` *because* that module is the single catalogue.

**Trust the audit no further than its red test.** Three of the checker's own false
positives surfaced while closing this list: classes held in a constant
(`className={button}`), a composed expression (`className={cn(BASE, tone)}`), and a
local class builder (`const classes = buttonClasses({…})` returning `cn(BUTTON_BASE, …)`)
— plus literal classes being dropped when a composition was expanded. Each fix ships
with a synthetic ring-less button that the rule must still catch, because a checker
that quietly stops catching real findings is worse than none.

`npm run check:motion` is at 0 for its five hard rules *and* its three soft
smells (`transition: all`, ad-hoc durations, inline animation durations, literal
easings, non-skipping `motion-reduce`, layout-animating properties, drag surfaces
without `.u-no-transition`, `@keyframes` outside `tokens.css`). Motion vocabulary
now includes a constant-rate token (`--ease-linear`) for loops and for
time-locked indicators such as the undo countdown.


**Floating panels (popups, menus, pickers):** the browser check `npm run check:popovers`
opens each one and *measures* it against the control that opened it — attached? flipped?
inside the viewport? did opening it move its trigger? It exists because a page menu once
opened in the corner of its header: the header has `backdrop-blur`, and a backdrop filter
(or a `transform`) makes that ancestor the **containing block for `position: fixed`**
descendants, so a panel's viewport coordinates get re-rooted. The rule that follows from
it:

- a panel positioned with `position: fixed` must be **portalled** (`FloatingLayer`) and
  placed with `placeFloating` — never left inside a blurred/transformed ancestor;
- a panel positioned with `absolute` and static offsets must **stay inline** (absolute
  already resolves against its positioned ancestor; portalling it moves it to the body);
- never use a magic z-index for a panel — place it at `Z.popover`.
- **anchoring convention**: every anchored popup renders through
  `FloatingLayer` + `placeFloating`, and its trigger is the element the placement
  is measured from. The reference implementation marks those triggers with
  `data-popup-origin`; we get the same guarantee structurally (the placement call
  takes the trigger's rect), so a popup cannot silently anchor to the wrong node.
- **structure vs drag**: structural size changes (sidebar collapse, pane toggles)
  animate on a token — `width var(--dur-2) var(--ease-smooth)` — while a
  *drag* resize must disable the transition (`u-no-transition`) so the edge
  tracks the cursor 1:1 instead of lagging behind it.
- **long documents**: the editor body carries a large bottom padding (30vh) so the
  last block can be scrolled to the middle of the viewport; without it, writing at
  the end of a long page pins you to the bottom edge.

Companion gates: `npm run check:coherence`, `npm run check:use-server`,
`npm run check:client` (no client component may reach a `node:` built-in — the
bug class that made `next build` fail while every test passed), and the visual
harness `npm run visual:check` (local or PR review — it needs a seeded database
and a browser, so it is intentionally not a CI step).
