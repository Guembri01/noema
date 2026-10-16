# Noema — Design System

The one place that defines *how things look and move*. Every component follows it;
`check:coherence` plus `src/lib/design-tokens.test.ts` stop it from drifting.

---

## 1. The four rules

1. **Colour** always comes from a token: `bg-surface-2`, `text-muted`, `border-border-strong`, `text-danger`.
   Never a raw hex in a component (`#eee`, `rgb(...)`) — only in `globals.css`, where the tokens are declared.
2. **Motion** always comes from a duration + easing token: `u-colors`, `animate-rise`, `DUR.base`.
   Never `transition: all .3s` and never an ad-hoc millisecond value.
3. **Layering** always comes from `Z.*` / `--z-*`. Never `z-[999]`.
4. **Shape** (radius, shadow, spacing) comes from the scale. Never `rounded-[7px]`, never a bespoke shadow.

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
(dialogs), `animate-slide-in-right` (drawers), `animate-shimmer` (skeletons),
`animate-pulse-soft`.

Utility classes: `.u-colors`, `.u-transform`, `.u-surface`, `.u-interactive`
(hover + `:active` scale), `.focus-ring`, `.surface-raised`, `.surface-raised-strong`,
`.scrollbar-thin`, `.no-scrollbar`, `.edge-fade-b`, `.u-no-transition`.

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

- [ ] No raw hex, no magic z-index, no ad-hoc duration/radius/shadow.
- [ ] All seven states implemented (see §8).
- [ ] Keyboard path exists for every pointer path.
- [ ] Works in light, dark and high-contrast (screenshot each).
- [ ] Works at 320 px wide and 200 % zoom.
- [ ] Reduced motion verified.
- [ ] Strings ready for i18n (no concatenation of sentences).
- [ ] Has a node test for its pure mapping and appears in a live check.
