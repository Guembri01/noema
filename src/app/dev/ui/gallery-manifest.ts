/**
 * Design-system gallery manifest.
 *
 * The single source of truth for `/dev/ui`: which primitives exist, which
 * section renders them, and which design tokens each section demonstrates.
 *
 * It is deliberately pure data (no React, no component imports) so the node
 * completeness test (`gallery.test.ts`) can read it without a DOM, and so the
 * manifest can never drift from `src/components/ui/`:
 *
 *   - every `*.tsx` file in `src/components/ui/` must appear in exactly one
 *     section's `files` (the test walks the directory and asserts set equality);
 *   - adding a primitive therefore fails the test until a section claims it;
 *   - the gallery renders one section per entry, so the coverage is visible on
 *     screen, not only in the test.
 *
 * `files` holds basenames without the `.tsx` extension.
 */

export const GALLERY_SECTIONS = [
  {
    id: "button",
    title: "Button",
    files: ["button"],
    tokens: [
      "--action",
      "--action-fg",
      "--action-soft",
      "--danger",
      "--danger-fg",
      "--danger-soft",
      "--surface-2",
      "--surface-3",
      "--radius-control",
      "--shadow-focus",
      "--dur-1",
    ],
  },
  {
    id: "input",
    title: "Input · Textarea · Field",
    files: ["input"],
    tokens: [
      "--border",
      "--border-strong",
      "--border-control",
      "--danger",
      "--surface-2",
      "--muted",
      "--radius-control",
      "--shadow-focus",
    ],
  },
  {
    id: "select",
    title: "Select · Combobox",
    files: ["select"],
    tokens: [
      "--surface-2",
      "--surface-3",
      "--z-popover",
      "--shadow-2",
      "--radius-lg",
      "--radius-sm",
      "--muted",
      "--tag-*-fg",
    ],
  },
  {
    id: "checkbox",
    title: "Checkbox",
    files: ["checkbox"],
    tokens: ["--action", "--action-fg", "--border-control", "--danger", "--radius-sm"],
  },
  {
    id: "switch",
    title: "Switch",
    files: ["switch"],
    tokens: ["--action", "--surface-3", "--border-control", "--shadow-1", "--dur-2", "--ease-spring"],
  },
  {
    id: "radio",
    title: "Radio group",
    files: ["radio"],
    tokens: ["--action", "--border-control", "--muted", "--radius-full"],
  },
  {
    id: "segmented",
    title: "Segmented control",
    files: ["segmented"],
    tokens: ["--surface-2", "--shadow-1", "--radius-md", "--radius-sm", "--dur-2", "--ease-spring"],
  },
  {
    id: "stepper",
    title: "Stepper",
    files: ["stepper"],
    tokens: ["--surface-2", "--surface-3", "--border", "--danger", "--radius-md"],
  },
  {
    id: "slider",
    title: "Slider · Range slider",
    files: ["slider"],
    tokens: [
      "--surface-2",
      "--action",
      "--border-strong",
      "--shadow-1",
      "--dur-2",
      "--ease-spring",
    ],
  },
  {
    id: "date-picker",
    title: "Date picker · Calendar grid",
    files: ["date-picker", "calendar-grid"],
    tokens: [
      "--surface-2",
      "--action",
      "--action-fg",
      "--selection-soft",
      "--focus",
      "--fg-subtle",
      "--radius-sm",
    ],
  },
  {
    id: "sheet",
    title: "Sheet",
    files: ["sheet"],
    tokens: ["--overlay", "--shadow-3", "--radius-overlay", "--z-overlay", "--z-modal", "--dur-3"],
  },
  {
    id: "confirm-dialog",
    title: "Confirm dialog",
    files: ["confirm-dialog"],
    tokens: [
      "--overlay",
      "--danger",
      "--danger-fg",
      "--danger-soft",
      "--action",
      "--action-soft",
      "--shadow-3",
      "--radius-overlay",
    ],
  },
  {
    id: "overlays",
    title: "Dialog · Popover · Dropdown menu",
    files: ["dialog", "popover", "dropdown-menu"],
    tokens: [
      "--overlay",
      "--shadow-2",
      "--shadow-3",
      "--z-overlay",
      "--z-popover",
      "--z-modal",
      "--radius-control",
      "--radius-overlay",
    ],
  },
  {
    id: "tooltip",
    title: "Tooltip",
    files: ["tooltip"],
    tokens: ["--fg", "--bg", "--shadow-2", "--z-tooltip", "--radius-md", "--dur-1"],
  },
  {
    id: "tag",
    title: "Tag · Chip",
    files: ["tag"],
    tokens: [
      "--tag-{gray,brown,orange,yellow,green,blue,purple,pink,red,teal}-{fg,bg,bd}",
      "--action-fg",
      "--radius-chip",
      "--shadow-focus",
    ],
  },
  {
    id: "badge",
    title: "Badge",
    files: ["badge"],
    tokens: [
      "--surface-2",
      "--accent-soft",
      "--success-soft",
      "--warning-soft",
      "--danger-soft",
      "--radius-chip",
    ],
  },
  {
    id: "avatar",
    title: "Avatar · Avatar group",
    files: ["avatar"],
    tokens: ["--surface", "--surface-2", "--success", "--warning", "--danger", "--radius-full"],
  },
  {
    id: "card",
    title: "Card",
    files: ["card"],
    tokens: ["--shadow-1", "--shadow-2", "--border", "--border-strong", "--surface-2", "--radius-card"],
  },
  {
    id: "section",
    title: "Section",
    files: ["section"],
    tokens: ["--fg", "--danger", "--muted", "--space-6"],
  },
  {
    id: "empty-state",
    title: "Empty state",
    files: ["empty-state"],
    tokens: ["--surface", "--muted", "--fg-subtle", "--radius-md"],
  },
  {
    id: "skeleton",
    title: "Skeleton",
    files: ["skeleton"],
    tokens: ["--surface-2", "--border", "--radius-sm", "--animate-shimmer"],
  },
  {
    id: "spinner",
    title: "Spinner",
    files: ["spinner"],
    tokens: ["--accent (currentColor)", "--muted", "--animate-spin"],
  },
  {
    id: "progress",
    title: "Progress · Progress ring",
    files: ["progress"],
    tokens: [
      "--surface-2",
      "--action",
      "--success",
      "--danger",
      "--fg-subtle",
      "--animate-shimmer",
      "--dur-2",
    ],
  },
  {
    id: "scroll-area",
    title: "Scroll area",
    files: ["scroll-area"],
    tokens: ["--border", "--border-strong", "--space-6", "--bg"],
  },
  {
    id: "virtual-list",
    title: "Virtual list",
    files: ["virtual-list"],
    tokens: ["--border", "--border-strong", "--surface-2", "--muted"],
  },
  {
    id: "resizable-panel",
    title: "Resizable panel",
    files: ["resizable-panel"],
    tokens: [
      "--focus",
      "--border",
      "--surface-2",
      "--z-sidebar",
      "--dur-2",
      "--ease-smooth",
      "--shadow-focus",
    ],
  },
  {
    id: "separator",
    title: "Separator",
    files: ["separator"],
    tokens: ["--border", "--border/60"],
  },
  {
    id: "kbd",
    title: "Kbd",
    files: ["kbd"],
    tokens: ["--surface", "--border", "--muted", "--radius-xs"],
  },
  {
    id: "toaster",
    title: "Toasts",
    files: ["toaster"],
    tokens: [
      "--success",
      "--danger",
      "--warning",
      "--accent",
      "--shadow-2",
      "--radius-md",
      "--z-toast",
    ],
  },
  {
    id: "route-progress",
    title: "Route progress",
    files: ["route-progress"],
    tokens: ["--action", "--z-sticky", "--dur-2", "--dur-3"],
  },
  {
    id: "emoji-picker",
    title: "Emoji picker",
    files: ["emoji-picker"],
    tokens: ["--surface-2", "--bg", "--shadow-xl", "--radius-lg"],
  },
  {
    /**
     * The animation-behaviour explorer (spec §10): one place to *watch* the
     * token vocabulary in motion, rather than read the states off static
     * primitives. See `motion-gallery.tsx`.
     *
     * `files` has to name a real primitive (the completeness test walks
     * `src/components/ui/` and fails on a claim with no file behind it), and no
     * file may be claimed twice — so demo C, the context menu, is owned here and
     * the motion gallery renders it. The rest of the section is the timing
     * vocabulary from `tokens.css`, not a component.
     */
    id: "animation-behavior",
    title: "Animation behaviour",
    titleKey: "motionGalleryTitle",
    files: ["context-menu"],
    tokens: [
      "--dur-1",
      "--dur-2",
      "--dur-3",
      "--dur-4",
      "--ease-smooth",
      "--ease-in-out-soft",
      "--ease-spring",
      "--action",
      "--action-fg",
      "--surface",
      "--surface-2",
      "--border",
      "--border-strong",
      "--shadow-1",
      "--shadow-focus",
      "--z-popover",
    ],
  },
] as const;

export type GallerySection = (typeof GALLERY_SECTIONS)[number];
export type GallerySectionId = GallerySection["id"];

/** Every primitive source file the gallery claims, as a flat sorted list. */
/**
 * Files in `src/components/ui` that have **no visual form**, so the gallery has
 * nothing to show: `FloatingLayer` is a portal helper (it renders its children
 * into `document.body` and has no markup or style of its own).
 *
 * The completeness test subtracts these, and only these — every *visual* primitive
 * still fails the test if it is not showcased, which is the point of the rule.
 */
export const NON_VISUAL_PRIMITIVES: readonly string[] = ["floating-layer"];

export function galleryCoveredFiles(): string[] {
  return [...new Set(GALLERY_SECTIONS.flatMap((section) => section.files))].sort();
}
