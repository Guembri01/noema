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
| Micro (kbd, badges) | `text-xs` | 12 / 16 |
| UI (menus, cells, labels) | `text-sm` | 13–14 / 20 |
| Prose (editor body) | `text-base` | 16 / 26 |
| Section title | `text-xl font-semibold tracking-[-0.01em]` | 20 |
| Page title | `text-[28px] font-semibold tracking-[-0.02em]` | 28 |

Rules: **never** invent a size; headings use tighter tracking, body never. Numbers in
tables use `tabular-nums`. Truncate rows with `truncate` + a `title` attribute.

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
| raw hex | 42 | 69 |
| arbitrary z-index | 0 | 2 |
| arbitrary duration | 5 | 7 |
| arbitrary radius | 0 | 0 |
| ad-hoc shadow | 0 | 0 |
| legacy palette | 93 | 155 |

170 files scanned; 29 files still carry at least one hit. The furthest from the
system are `auth-form.tsx`, `database/view-renderers.tsx`, `editor/page-editor.tsx`
and `audit-feed.tsx` (all "legacy palette", some "raw hex" / "arbitrary
duration"). These are the remaining adoption targets — see the build order in
`FRONTEND_PLAN.md` §22.
