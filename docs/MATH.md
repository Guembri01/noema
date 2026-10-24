# Equations (KaTeX / LaTeX)

Inline and block equations render through KaTeX. This page documents the
supported input, the bounded macro set, and the safety rules the editor and
read-only renderer share.

## Input

| Surface | Syntax | Notes |
| --- | --- | --- |
| Inline equation | `$x^2$`, or the bubble-toolbar equation button | A selection is replaced, not duplicated. |
| Block equation | `$$...$$`, `/equation`, or the block context menu's **Edit equation** | Click any equation to reopen the dialog. |
| Dialog source | Raw LaTeX such as `\frac{a}{b}` | Delimiters are optional in the dialog. |

The equation dialog has two explicit states:

- **LaTeX** — the source box stays mounted and focused, with a live preview
  underneath. A symbol palette splices snippets at the caret.
- **Preview** — the rendered equation fills the pane. Switching back restores
  focus and the saved caret, so inline editing never loses its place.

`Apply` writes the trimmed source. `Cancel`, `Escape`, a scrim click, or a blur
that leaves the dialog discards the draft; the document (and the equation's
existing source) is left untouched.

## Bounded macro set

The macro table lives in `src/lib/math-macros.ts` and is shared by the dialog,
the node views, and the preview. It is deliberately small and visual-only:

| Macro | Expands to | Example |
| --- | --- | --- |
| `\RR`, `\NN`, `\ZZ`, `\QQ`, `\CC`, `\PP` | `\mathbb{...}` | `\RR^n` |
| `\abs{x}` | `\left|x\right|` | `\abs{x-y}` |
| `\norm{x}` | `\left\lVert x\right\rVert` | `\norm{v}` |
| `\inner{u}{v}` | `\left\langle u,v\right\rangle` | `\inner{u}{v}` |
| `\dd` | `\mathrm{d}` | `\dd x` |
| `\pd` | `\partial` | `\pd f` |
| `\degree` | `^{\circ}` | `90\degree` |
| `\half` | `\frac{1}{2}` | `\half` |
| `\qed` | `\blacksquare` | `\qed` |

Bounds enforced by `expandMacros`:

- maximum expansion depth: `MATH_MACRO_MAX_DEPTH` (8);
- maximum emitted characters: `MATH_MACRO_MAX_LENGTH` (20 000);
- cycles (`\a -> \a`, `\a -> \b -> \a`) stop and keep the source token.

KaTeX itself runs with `maxExpand: 1000`, `maxSize: 50`, and
`trust: false`. URL/HTML/file commands (`\href`, `\url`, `\htmlClass`,
`\includegraphics`, …) and banned TeX commands (`\input`, `\include`,
`\write18`) are rejected with an inline message rather than rendered.

## Errors

Invalid LaTeX never throws. The dialog shows a danger-ringed source box and an
inline `role="alert"`; the editor node view shows the escaped source plus the
message; the read-only `DocRenderer` reports structural errors (unbalanced
braces, environments, banned commands) inline. No path passes authored HTML to
`dangerouslySetInnerHTML` — only KaTeX's own escaped output is injected.

## Tests

- `src/lib/math-tex.test.ts` — macro set, inline/block output, bounds, unsafe
  commands, error normalisation.
- `src/lib/equation-editing.test.ts` — draft state, cancel/blur, blank drafts,
  stale-position guard.
- `src/components/editor/extensions/math-node.test.ts` — inline/block node
  surfaces, inline error, empty state, HTML escaping.
- `src/components/editor/equation-editor.test.ts` — dialog panes, live preview,
  error state, tokens-only guard.
- `src/components/doc-renderer.test.ts` — read-path equation errors.
