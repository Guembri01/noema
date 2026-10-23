# Noema Component Inventory & Visual Audit

> Local audit generated from the source on 2026-10-23. The follow-up implementation was applied locally; nothing was committed or pushed, and no production data was modified.

## Scope

- **171 non-test component files** under `src/components`.
- **63 route/page files** under `src/app` (listed in Appendix A; they are screen compositions, not reusable primitives).
- Tests, stories and generated files excluded.
- “Style” is a source fingerprint: the accent/radius/focus/shadow utilities actually present in the file, not a guess from a screenshot.

## Executive verdict

This is not a missing design system. It is a **strict system with inherited choices** that make the UI feel harsher than it needs to:

1. **One blue does too many jobs.** Accent is used for primary actions, links, focus, selection, checked states, active rows and charts.
2. **Radii are small and semantically unstable.** Shared Button/Input are 4px, Card is 6px, but the app also uses 10px search fields, 14px cards, 14px dialogs and 206 bare `rounded` utilities.
3. **Focus and selection are painted by overlapping layers.** The global 2px accent outline, `.focus-ring` 3px blue halo, `focus:border-accent`, and `ring-2 ring-accent` often appear together.
4. **Too many fields are hand-rolled.** Search bars, project forms, ticket drawers and sidebar filters bypass `Input`/`Field`, so each one gets its own focus treatment.
5. **The app has primitives but not enough composites.** There is no shared `SearchField`, `PageHeader`, `DatabaseShell`, `SettingsSection` or `BrandLockup` in the catalog.

**The gate proves consistency of implementation, not quality of decisions.** `0 raw hex` and `0 arbitrary radius` can still mean “every screen uses a different step of the same scale.”

## The recommended visual direction

Keep the calm, paper-like workspace. Make it feel softer and more intentional:

| Signal | Current | Recommended |
|---|---|---|
| Primary action | Bright blue `#156cc7` | Charcoal/ink `#2f3437`, or a deeper blue `#1f5f9e` |
| Link / info | Same blue | `#2f6f9f` or the current blue, used only for links/info |
| Focus | Blue outline + blue halo + blue border | One neutral 2px ring with a soft halo |
| Selection | Blue ring / blue text highlight | Soft tinted fill; amber/neutral highlight for search matches |
| Controls | 4px | 8px role token |
| Cards | 6px | 12px role token |
| Overlays | 10/14px | 14px role token |
| Chips | 4px | 6px role token |

**Rule of thumb:** **Selection = fill. Focus = ring. Action = colour.** Do not use the same blue ring for all three.

## Implementation status (2026-10-23)

The recommended direction is now implemented across the component and route inventory:

- **Roles split:** `action` (ink primary), `link`/`accent` (calm blue links + info), `focus` (one neutral ring), `selection-soft` (soft fill), `highlight` (amber search matches).
- **Radius roles:** `rounded-control` 8px, `rounded-card` 12px, `rounded-overlay` 14px, `rounded-chip` 6px; numeric scale `xs 4 / sm 6 / md 8 / lg 12 / xl 14`.
- **Interaction rule applied:** selected/active rows and cells use a soft fill or neutral surface; focus uses one neutral ring; primary actions use the ink action colour.
- **Scope:** all 171 component files and 63 route compositions inherit the new tokens and scale; the P1 component states were updated individually.
- **Second full sweep:** control constants, menu rows, database cells, navigation rows, editor toolbars, settings forms, import surfaces, tickets, dialogs and gallery demos were normalized to `rounded-control`; cards/panels to `rounded-card`; dialogs/sheets to `rounded-overlay`; chips/tags to `rounded-chip`. Numeric aliases remain only where they are intentional: 16 px checkboxes, skeletons, media/video, data-visualisation bars/markers and inline link focus targets. Segmented controls keep equal-width segments but now enforce a 5 rem minimum segment width so labels cannot collapse in flex-wrapped toolbars; the gallery opens portal demos on interaction instead of leaving menus floating over later sections.
- **Intentional remaining blue:** links, `accent` info badges, and data-visualisation series/markers. These are semantic, not primary actions.

Verification for this pass:

- `npm run typecheck` - passed.
- `npm run check:design` - 222 files scanned, 0 raw hex / arbitrary radius / legacy palette hits.
- `npm test` - 729 files passed, 14,038 tests passed, 12 skipped.
- `npm run lint` - 0 errors, 1,180 warnings (existing repo warnings; no new errors).
- `/dev/ui` - rendered in light, dark and high-contrast; dialogs, menus, popovers, tag/chip, calendar and card sections inspected. Landing and sign-in surfaces also checked locally. No browser console or page errors were observed.

## The 10 changes that will make the biggest difference

1. **Stop painting selection with a 2px accent ring.** Use a soft fill or a left rail for selected cells, comments, labels, icons, avatars and toolbar items.
2. **Make focus neutral.** One 2px ring with a soft halo, not a blue border + blue glow + blue outline.
3. **Split action from link.** Primary action gets the action colour; blue is reserved for links/info.
4. **Set a role-based radius scale.** 8px controls, 12px cards, 14px overlays, 6px chips.
5. **Remove `focus:border-accent` from hand-rolled fields.** They should use `Input`/`Field` and one focus system.
6. **Use an amber/neutral highlight for search matches.** Blue matches look like links.
7. **Make sidebar/topbar active states neutral.** Use a left rail or soft fill, not accent.
8. **Soften cards.** Hairline border; shadow only for raised/interactive surfaces.
9. **Add the missing composites.** `SearchField`, `PageHeader`, `DatabaseShell`, `SettingsSection`, `BrandLockup`.
10. **Put it all in `/dev/ui`.** Foundations, primitives, composites, patterns, and a state matrix.

## Priority key

- **P1** — high visual impact, semantic confusion, or a repeated blue focus/selection bug.
- **P2** — consistency/polish issue; worth fixing after P1.
- **P3** — no visual issue, or infrastructure/behavior only.


## P1 shortlist (34)

These are the first components to touch. Everything else can wait until the tokens and these shared surfaces are corrected.

| Component(s) | File | Why it is P1 | Best fix |
|---|---|---|---|
| AboutDialog | `src/components/about-dialog.tsx` | Blue logo tile; mixed 4/10/14px radii; blue primary action. | Ink mark; 12px dialog; one primary; neutral focus. |
| ProviderCard, PromptCard, BudgetUsageBar | `src/components/ai-settings-providers.tsx` | Selected provider card uses `ring-1 ring-accent`; 6px cards. | Neutral selected border or soft fill; 12px card; accent only for status. |
| AuthShell | `src/components/auth-shell.tsx` | Blue `bg-accent-soft` blur blob; 6/10px cards; generic auth panel. | Replace the blob with an editorial brand panel or quiet pattern; ink mark; 12px card; one primary. |
| NoemaWordmark | `src/components/brand/noema-wordmark.tsx` | Blue 6px tile with the mark; shadow-1. | Ink-first tile or no tile; one accent detail; 12px tile; keep the wordmark monochrome. |
| TypingIndicator, ChatPanelSkeleton, ChatEmptyState +2 | `src/components/chat-panel.tsx` | Blue send button and blue-connected states; mixed 3/4/6/10px radii. | Neutral message bubbles; action colour for send; 12px bubbles; neutral focus. |
| CommandPalette | `src/components/command-palette.tsx` | Blue active row; 4px rows; global blue focus outline. | Neutral active row; 8px rows; 10px dialog; accent only for icons. |
| CommentPanel | `src/components/comment-panel.tsx` | Selected comment uses `border-accent bg-accent-soft ring-2 ring-accent/30`; blue composer. | Soft selected fill; 12px panel; neutral focus; accent only for send. |
| TableView | `src/components/database/table-view.tsx` | Dense spreadsheet chrome; 4px cells; blue selection rings; many borders. | One `DatabaseShell`; sticky header; neutral row hover; soft selected fill; 8px toolbar controls. |
| PropertyHeader, Cell, AddPropertyForm | `src/components/database/view-parts.tsx` | Selected and editing cells use `ring-2 ring-accent`; focus adds `ring-2 ring-ring/60`. Selection and focus are both blue rings. | Selected = soft fill; focus = neutral ring; 4px cells are fine for density, but standalone fields 8px. |
| BubbleToolbar, SwatchButton | `src/components/editor/bubble-toolbar.tsx` | Active formatting uses `ring-2 ring-accent`; 4px buttons. | Neutral active fill; 6px toolbar buttons; accent only for link/active icon. |
| ImageBlock, ImageView | `src/components/editor/extensions/image-block.tsx` | Selected image uses a 2px accent outline; block radius 6/4px. | Neutral 1px outline plus visible handles; keep the 6px image radius. |
| FindBar | `src/components/editor/find-bar.tsx` | Blue focus and accent match count; 4px field. | Neutral focus; 8px field; use a highlight token for matches. |
| SlashMenuSurface, SlashMenu | `src/components/editor/slash-menu.tsx` | Blue active row; 4px menu. | Neutral active row; 10px menu; accent only for icons. |
| LabelManager | `src/components/label-manager.tsx` | Active label uses `ring-2 ring-accent ring-offset-1`; 4/6px chips. | Soft selected fill or left rail; 6px chips; neutral focus. |
| PageTitleRow, PageTitle | `src/components/page-title.tsx` | Many icon actions; blue hover; 4px controls; crowded header. | Group actions into one overflow; 32px targets; neutral hover; one primary. |
| ProjectDetail | `src/components/project-detail.tsx` | 14px cards; several hand-rolled inputs with `focus:border-accent`; dense metadata. | Card 12px; Field/Input 8px; neutral focus; one primary; move metadata into a sidebar. |
| ProjectCardTile, ProjectsBoard | `src/components/projects-board.tsx` | 14px cards; hand-rolled inputs with `focus:border-accent`; blue accents. | Card 12px; Field/Input 8px; status hues; one primary; muted secondary actions. |
| QuickFind | `src/components/quick-find.tsx` | Auto-focused input gets the global blue outline; active rows use `bg-accent-soft`; 4px rows. | Use `SearchField` with neutral focus; 8px rows; soft active fill; 10px dialog. |
| SearchResults | `src/components/search-results.tsx` | Blue match highlights; 10px result cards; accent links. | Amber/neutral highlight; 12px cards; neutral focus; accent only for links. |
| ShareSection, Switch, PublishSettingsSection +3 | `src/components/share-dialog.tsx` | Blue checkbox/switch and 4/6px controls inside a 14px dialog. | Action colour for checked state; 8px controls; 14px dialog; one primary. |
| Sidebar | `src/components/sidebar.tsx` | Dense 6px rows; accent active states; many sections in one column. | 8px rows; neutral active with a left rail; 40px targets; collapse secondary sections. |
| PageTreeRow, PageTree | `src/components/sidebar/page-tree.tsx` | Accent selected/active rows; 4/6px rows; inline rename field uses `focus:border-accent`. | Neutral active + left rail; 8px rows; shared Input for rename; neutral focus. |
| TicketDrawerBody, TicketDrawer | `src/components/tickets/ticket-drawer.tsx` | Hand-rolled inputs with `focus:border-accent`; 4/6/10px controls; dense drawer. | Field/Input 8px; neutral focus; 12px cards; sticky footer with one primary. |
| ActionsMenu, CustomizePanel | `src/components/topbar/actions-menu.tsx` | Selected icons/rows use `ring-2 ring-accent` or `ring-1 ring-accent`; many icon actions. | Neutral selected state; group secondary actions into an overflow; 8px controls. |
| Button | `src/components/ui/button.tsx` | Primary, link, focus and selection all use the same accent blue. 4px control radius. Global outline and `.focus-ring` both paint. | Use an action token (charcoal or deep blue), 8px control radius, one neutral focus ring; reserve bright blue for links/info. |
| CalendarGrid | `src/components/ui/calendar-grid.tsx` | Blue selected/range dates; 4px cells; selection and focus are visually close. | Soft tinted selection, neutral focus, 8px controls; show today with a dot, not a second blue. |
| Card, CardMedia, CardTitle +5 | `src/components/ui/card.tsx` | 6px card radius is much tighter than 10/14px overlays. Border plus shadow can look busy on every card. | 12px card radius; hairline border; shadow only for raised/interactive cards. |
| DatePicker | `src/components/ui/date-picker.tsx` | 4px controls and blue today/selected states; many presets crowd the panel. | Use Input/Button tokens; 8px controls; soft selection; move presets into a single row. |
| Dialog, DialogTrigger, DialogClose +1 | `src/components/ui/dialog.tsx` | 14px dialog with a strong shadow; global blue outline can appear on inputs inside. | 14px overlay, softer shadow, neutral focus, consistent 24px padding. |
| Input, Textarea, Field | `src/components/ui/input.tsx` | 4px radius. Focus stacks a blue border, a 3px blue halo and the global 2px blue outline. | 8px control radius; 1px border; neutral focus ring. Build a shared `SearchField` instead of hand-rolled search inputs. |
| Select | `src/components/ui/select.tsx` | Mixed 6/4px radii; accent text; menu hover/selection uses blue. | 8px control, 10px menu, neutral hover, accent only for the selected value or icon. |
| Sheet | `src/components/ui/sheet.tsx` | Large overlay with mixed radius/shadow; dense controls inside. | 14px overlay; 8px controls; consistent footer with one primary action. |
| CreateWorkspaceButton, EditWorkspaceButton, WorkspaceDialog | `src/components/workspace-dialog.tsx` | Selected workspace icon uses `bg-surface-2 ring-1 ring-accent`; 4/6px controls. | Neutral selected tile; 8px controls; accent only for the check. |
| WorkspaceShell | `src/components/workspace-shell.tsx` | Many icon actions; blue hover/active; 4px controls; topbar and page header feel crowded. | Group secondary actions into an overflow; 40px targets; neutral hover; 8px controls; one primary per page. |


## UI primitives (36)

The kit is tokenized and tested. The problem is the token choices: one accent, 4/6/10/14px radii, and a focus system that stacks.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| Avatar, AvatarGroup | `src/components/ui/avatar.tsx` | radii full; surface-2 | Full radius is fine; status ring may use accent. | Keep; use a neutral ring to separate overlapping avatars. | P2 |
| Badge | `src/components/ui/badge.tsx` | accent soft; accent ink; radii 4px; surface-2; hairline | 4px chips read sharp next to 6px cards. Accent tone competes with links. | 6px chip radius; soft tones; keep accent only for informational badges. | P2 |
| Button | `src/components/ui/button.tsx` | accent fill; accent soft; accent ink; focus-ring; radii 4px; surface-2; hairline | Primary, link, focus and selection all use the same accent blue. 4px control radius. Global outline and `.focus-ring` both paint. | Use an action token (charcoal or deep blue), 8px control radius, one neutral focus ring; reserve bright blue for links/info. | P1 |
| CalendarGrid | `src/components/ui/calendar-grid.tsx` | accent fill; accent soft; accent ink; focus-ring; radii 4px; surface-2 | Blue selected/range dates; 4px cells; selection and focus are visually close. | Soft tinted selection, neutral focus, 8px controls; show today with a dot, not a second blue. | P1 |
| Card, CardMedia, CardTitle +5 | `src/components/ui/card.tsx` | focus-ring; shadow-2; shadow-1; radii 6px; surface-2; hairline | 6px card radius is much tighter than 10/14px overlays. Border plus shadow can look busy on every card. | 12px card radius; hairline border; shadow only for raised/interactive cards. | P1 |
| Checkbox | `src/components/ui/checkbox.tsx` | accent fill; accent border; focus-ring; radii 4px | Checked state uses the same blue as primary and focus, so checked and focused controls look related. | Use the action colour for the check, 6px radius, and a neutral focus ring. | P2 |
| ConfirmDialog | `src/components/ui/confirm-dialog.tsx` | accent fill; accent soft; accent ink; accent border; accent focus; focus-ring; radii 3px/6px; surface-2; hairline | Dialog buttons use 6px while the shared Button is 4px; input uses `focus:border-accent`. | Use Button + Input; 8px controls; danger red for destructive action. | P2 |
| ContextMenu, ContextMenuTrigger, ContextMenuGroup +9 | `src/components/ui/context-menu.tsx` | menu surface (`surface-raised`), 6px, accent hover/selected | 6px menu surface while popovers use 10px; accent hover/selected rows. | 10px menu radius; neutral hover; 8px rows; accent only for checkmarks. | P2 |
| DatePicker | `src/components/ui/date-picker.tsx` | accent fill; focus-ring; radii 4px; surface-2; hairline | 4px controls and blue today/selected states; many presets crowd the panel. | Use Input/Button tokens; 8px controls; soft selection; move presets into a single row. | P1 |
| Dialog, DialogTrigger, DialogClose +1 | `src/components/ui/dialog.tsx` | dialog surface (`surface-raised-strong`), 14px, shadow-3 | 14px dialog with a strong shadow; global blue outline can appear on inputs inside. | 14px overlay, softer shadow, neutral focus, consistent 24px padding. | P1 |
| MenuNavContext, DropdownMenu, DropdownMenuTrigger +13 | `src/components/ui/dropdown-menu.tsx` | menu surface (`surface-raised`), 6px, accent hover/selected | 6px menu surface while popovers use 10px; accent hover/selected rows. | 10px menu radius; neutral hover; accent only for checkmarks and destructive icon. | P2 |
| EmojiPicker | `src/components/ui/emoji-picker.tsx` | focus-ring; radii 10px/4px default; surface-2; hairline | 10px surface with 4px cells; very dense. | 10px surface; 8px cells; neutral hover; larger hit areas. | P2 |
| EmptyState | `src/components/ui/empty-state.tsx` | radii 6px; surface | 6px icon tile; generic empty copy; no brand presence. | 12px tile, brand mark or simple illustration, one sentence, one primary action. | P2 |
| FloatingHostProvider, FloatingLayer | `src/components/ui/floating-layer.tsx` | layout/behavior only | No visual issue; positioning layer. | Keep. | P3 |
| Input, Textarea, Field | `src/components/ui/input.tsx` | focus-ring; radii 3px/4px; surface-2 | 4px radius. Focus stacks a blue border, a 3px blue halo and the global 2px blue outline. | 8px control radius; 1px border; neutral focus ring. Build a shared `SearchField` instead of hand-rolled search inputs. | P1 |
| Kbd | `src/components/ui/kbd.tsx` | radii 3px; surface; hairline | 3px radius is intentional and fine. | Keep; no change. | P2 |
| Popover, PopoverTrigger, PopoverAnchor +2 | `src/components/ui/popover.tsx` | popover surface (`surface-raised`), 10px, shadow-2 | 10px popover; 6px menus; inconsistent overlay language. | Use one overlay token (12–14px) for popovers, menus and dialogs. | P2 |
| Progress, ProgressRing | `src/components/ui/progress.tsx` | accent fill; accent ink; radii full/4px default; surface-2 | Accent is used for progress, so progress competes with primary actions. | Use action/info colour; keep the track neutral; add a value label. | P2 |
| RadioGroup, Radio | `src/components/ui/radio.tsx` | accent fill; accent border; focus-ring; radii full | Blue dot uses the action accent; shape is fine. | Use the action colour; keep the circle; neutral focus ring. | P2 |
| ResizablePanel | `src/components/ui/resizable-panel.tsx` | accent fill; focus-ring; radii 4px default | Accent drag handle; 4px focus area. | Neutral handle, 4px hit area, neutral focus ring. | P2 |
| RouteProgressBar, RouteProgress | `src/components/ui/route-progress.tsx` | accent fill | Accent bar at the top of every route. | Keep it subtle; use action colour; reduce motion under `prefers-reduced-motion`. | P2 |
| ScrollArea | `src/components/ui/scroll-area.tsx` | layout/behavior only | No visual issue; thin scrollbars are appropriate. | Keep. | P3 |
| Section | `src/components/ui/section.tsx` | layout/behavior only | Structure is good; spacing varies between settings pages. | Standardise 24px section gaps, 16px inner gap, one header pattern. | P3 |
| Segmented | `src/components/ui/segmented.tsx` | focus-ring; shadow-1; radii 4px/6px; surface-2; hairline | 6/4px radii with a shadow; active state can compete with accent. | 8px container / 6px thumb; neutral active; 40px height. | P2 |
| Select | `src/components/ui/select.tsx` | accent ink; focus-ring; radii 3px/4px/6px/full; surface-2 | Mixed 6/4px radii; accent text; menu hover/selection uses blue. | 8px control, 10px menu, neutral hover, accent only for the selected value or icon. | P1 |
| Separator | `src/components/ui/separator.tsx` | layout/behavior only | No visual issue. | Keep; add to the gallery. | P3 |
| Sheet | `src/components/ui/sheet.tsx` | sheet surface (`surface-raised-strong`), 14px, shadow-3 | Large overlay with mixed radius/shadow; dense controls inside. | 14px overlay; 8px controls; consistent footer with one primary action. | P1 |
| Skeleton | `src/components/ui/skeleton.tsx` | shadow-1; radii 4px/6px/full; surface-2; hairline | Skeleton radii may not match the final component. | Mirror the final radius; subtle shimmer; respect reduced motion. | P2 |
| Slider, RangeSlider | `src/components/ui/slider.tsx` | accent fill; accent border; focus-ring; shadow-1; radii 4px/full; surface-2; hairline | Blue thumb/rail; 4px handle; accent border on hover. | 8px thumb, action colour, neutral focus, larger hit area. | P2 |
| Spinner | `src/components/ui/spinner.tsx` | layout/behavior only | Tokenized primitive, but the shared token choices (accent overload, 4/6px radii, blue focus) still apply. | Move to role tokens: action/link/focus/selection; 8px controls, 12px cards; neutral focus. | P3 |
| Stepper | `src/components/ui/stepper.tsx` | accent border; accent focus; focus-ring; radii 6px/4px default; surface-2; hairline | Hand-rolled number input with `focus:border-accent`; 6px radius. | Use Input + Field; neutral focus; 8px radius. | P2 |
| Switch | `src/components/ui/switch.tsx` | accent fill; accent border; focus-ring; radii full; surface | Blue track uses the same accent as primary and focus, so state and action compete. | Use action colour or a neutral track; reserve blue for links. | P2 |
| Tag | `src/components/ui/tag.tsx` | focus-ring; radii 3px/full | Tag hues are good; focus ring is blue. | Keep hues; 6px or pill shape; neutral focus ring. | P2 |
| ToastView, Toaster | `src/components/ui/toaster.tsx` | accent ink; focus-ring; shadow-2; radii 4px/6px; surface-2; hairline | Accent text for info; 6px radius. | Status colour on the icon only; neutral surface; 10px radius. | P2 |
| TooltipRoot, TooltipTrigger, TooltipProvider +3 | `src/components/ui/tooltip.tsx` | tooltip surface, 6px, shadow-2 | 6px dark surface; fine but tight. | 8px radius; 6px offset; drop the shadow on dark surfaces. | P2 |
| VirtualList | `src/components/ui/virtual-list.tsx` | layout/behavior only | No visual issue; layout/behavior only. | Keep. | P3 |

## Brand (3)

The mark and wordmark exist but are not in the gallery. The blue tile makes the brand read like an app icon rather than an editorial mark.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| NoemaMark | `src/components/brand/noema-mark.tsx` | SVG mark only; inherits the container | Brand surfaces use accent fills and 10/6px radii; the mark can read as a generic blue app tile. | Ink-first mark, one accent detail, clearspace; 12px tile; keep the wordmark monochrome. | P2 |
| NoemaWordmark | `src/components/brand/noema-wordmark.tsx` | accent fill; focus-ring; shadow-1; radii 6px | Blue 6px tile with the mark; shadow-1. | Ink-first tile or no tile; one accent detail; 12px tile; keep the wordmark monochrome. | P1 |
| BrandedLoading | `src/components/branded-loading.tsx` | radii 10px | Brand surfaces use accent fills and 10/6px radii; the mark can read as a generic blue app tile. | Ink-first mark, one accent detail, clearspace; 12px tile; keep the wordmark monochrome. | P2 |

## Topbar & app shell (6)

The shell is where the ‘too many blue controls’ feeling is strongest: many icon buttons, blue hover/active, and a crowded page header.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| NavHistory | `src/components/nav-history.tsx` | focus-ring; radii 4px; surface-2 | Many icon actions; blue hover/active; 4px controls; topbar and page header feel crowded. | Group secondary actions into an overflow; 40px targets; neutral hover; 8px controls; one primary per page. | P2 |
| PageTitleRow, PageTitle | `src/components/page-title.tsx` | accent fill; accent ink; focus-ring; shadow-1; radii 4px/4px default; surface-2; hairline | Many icon actions; blue hover; 4px controls; crowded header. | Group actions into one overflow; 32px targets; neutral hover; one primary. | P1 |
| ThemeToggle | `src/components/theme-toggle.tsx` | focus-ring; radii 6px; surface-2; hairline | Many icon actions; blue hover/active; 4px controls; topbar and page header feel crowded. | Group secondary actions into an overflow; 40px targets; neutral hover; 8px controls; one primary per page. | P2 |
| ActionsMenu, CustomizePanel | `src/components/topbar/actions-menu.tsx` | accent fill; accent ring; focus-ring; radii 4px; surface-2; hairline | Selected icons/rows use `ring-2 ring-accent` or `ring-1 ring-accent`; many icon actions. | Neutral selected state; group secondary actions into an overflow; 8px controls. | P1 |
| AvatarStack | `src/components/topbar/avatar-stack.tsx` | accent ring; radii full; surface-2 | Many icon actions; blue hover/active; 4px controls; topbar and page header feel crowded. | Group secondary actions into an overflow; 40px targets; neutral hover; 8px controls; one primary per page. | P2 |
| WorkspaceShell | `src/components/workspace-shell.tsx` | focus-ring; radii 4px/6px; surface-2; hairline | Many icon actions; blue hover/active; 4px controls; topbar and page header feel crowded. | Group secondary actions into an overflow; 40px targets; neutral hover; 8px controls; one primary per page. | P1 |

## Sidebar & navigation (8)

Dense Notion-style navigation. The active row uses accent, so navigation, selection and focus compete.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| ChatThreadSkeleton, ChatThreadsEmpty, SidebarChat | `src/components/sidebar-chat.tsx` | focus-ring; radii 3px/4px; surface-2 | Dense 4/6px rows, blue active states, many icon actions. | 8px rows; neutral active row with a left rail; 40px targets; accent only for the primary action. | P2 |
| SidebarMeetings | `src/components/sidebar-meetings.tsx` | accent fill; accent ink; accent border; accent focus; focus-ring; radii 6px/10px/4px default; surface-2; hairline | Dense 4/6px rows, blue active states, many icon actions. | 8px rows; neutral active row with a left rail; 40px targets; accent only for the primary action. | P2 |
| Sidebar | `src/components/sidebar.tsx` | focus-ring; radii 6px; surface-2; hairline | Dense 6px rows; accent active states; many sections in one column. | 8px rows; neutral active with a left rail; 40px targets; collapse secondary sections. | P1 |
| HomeQuickLinks, FavoritesList, RecentList | `src/components/sidebar/home-links.tsx` | focus-ring; radii 4px/6px; surface-2 | Dense 4/6px rows, blue active states, many icon actions. | 8px rows; neutral active row with a left rail; 40px targets; accent only for the primary action. | P2 |
| ImportSourceCard, ImportSourceGrid, ImportSteps +8 | `src/components/sidebar/importers.tsx` | accent fill; accent soft; accent ink; accent border; focus-ring; shadow-2; radii 3px/6px/10px/full; surface-2; hairline | Dense 4/6px rows, blue active states, many icon actions. | 8px rows; neutral active row with a left rail; 40px targets; accent only for the primary action. | P2 |
| PageTreeRow, PageTree | `src/components/sidebar/page-tree.tsx` | accent fill; accent soft; accent border; accent focus; focus-ring; shadow-2; radii 4px/6px/full/4px default; surface-2; hairline | Accent selected/active rows; 4/6px rows; inline rename field uses `focus:border-accent`. | Neutral active + left rail; 8px rows; shared Input for rename; neutral focus. | P1 |
| SidebarFooter | `src/components/sidebar/sidebar-footer.tsx` | focus-ring; radii full/4px default; surface-2; hairline | Dense 4/6px rows, blue active states, many icon actions. | 8px rows; neutral active row with a left rail; 40px targets; accent only for the primary action. | P2 |
| WorkspaceSwitcherMenu, WorkspaceSwitcher | `src/components/sidebar/workspace-switcher.tsx` | focus-ring; radii 4px; surface-2 | Dense 4/6px rows, blue active states, many icon actions. | 8px rows; neutral active row with a left rail; 40px targets; accent only for the primary action. | P2 |

## Editor (24)

The content canvas is the calmest surface. Selected nodes, images and toolbars are where the loud blue outlines appear.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| BlockColorMenu, BlockContextMenu | `src/components/editor/block-context-menu.tsx` | focus-ring; radii 4px; surface-2; hairline | 4px menu; accent colour swatches. | 8px menu; 6px swatches; neutral hover. | P2 |
| BubbleToolbar, SwatchButton | `src/components/editor/bubble-toolbar.tsx` | accent fill; accent soft; accent ink; accent ring; focus-ring; radii 3px/4px; surface-2; hairline | Active formatting uses `ring-2 ring-accent`; 4px buttons. | Neutral active fill; 6px toolbar buttons; accent only for link/active icon. | P1 |
| EquationDialogSurface, EquationEditor | `src/components/editor/equation-editor.tsx` | accent fill; focus-ring; radii 4px/6px; surface-2; hairline | 6/4px surface; accent buttons. | 10px dialog; 8px controls; neutral focus. | P2 |
| AnimatedImage, AnimatedImageView | `src/components/editor/extensions/animated-image.tsx` | focus-ring; radii 6px | 6px image; motion controls. | 8px image; neutral controls; respect reduced motion. | P2 |
| AskAi | `src/components/editor/extensions/ask-ai.tsx` | focus-ring | Accent CTA in editor. | Use action colour; neutral focus; 8px. | P2 |
| Bookmark, BookmarkCardSurface, BookmarkView +3 | `src/components/editor/extensions/bookmark.tsx` | focus-ring; radii 6px; surface-2; hairline | 6px cards; accent links. | 10px cards; neutral border; accent only for the title link. | P2 |
| Breadcrumb | `src/components/editor/extensions/breadcrumb.tsx` | layout/behavior only | 4px crumbs; accent links. | Neutral crumbs; 6px hover; accent only for the final link. | P3 |
| CodeBlock, CodeBlockChrome | `src/components/editor/extensions/code-block.tsx` | accent soft; accent ink | Accent copy control and 4px chrome. | Neutral chrome; accent only on hover/focus; 6px surface. | P2 |
| Callout, Toggle, ToggleHeading +4 | `src/components/editor/extensions/custom-blocks.tsx` | layout/behavior only | Calm content canvas, but selected blocks/images use loud accent outlines/tints and toolbars use mixed radii. | Neutral selection with handles; one floating toolbar language; 4px inline blocks, 8px controls. | P3 |
| ImageBlock, ImageView | `src/components/editor/extensions/image-block.tsx` | focus-ring; radii 6px/4px default | Selected image uses a 2px accent outline; block radius 6/4px. | Neutral 1px outline plus visible handles; keep the 6px image radius. | P1 |
| LinkedDatabase | `src/components/editor/extensions/linked-database.tsx` | radii 10px; surface; hairline | 10px surface; dense table. | 12px surface; same database shell; neutral focus. | P2 |
| PageEmbed | `src/components/editor/extensions/page-embed.tsx` | layout/behavior only | 4px embed card. | 10px card; neutral hover; accent only for link. | P3 |
| SyncedBlock | `src/components/editor/extensions/synced-block.tsx` | focus-ring | 4px surface; focus ring. | 8px surface; neutral focus. | P2 |
| TableGutterButton, TableDragGrip, TableDeleteControl +2 | `src/components/editor/extensions/table.tsx` | accent fill; accent soft; accent ink; accent border; focus-ring | Selected cells use accent border/fill; 4px controls. | Soft selection fill; neutral focus; keep 4px cell radius. | P2 |
| TemplateButton, ButtonBlock | `src/components/editor/extensions/template-button.tsx` | focus-ring | Focus ring; 4px button. | 8px button; action colour; neutral focus. | P2 |
| FindBar | `src/components/editor/find-bar.tsx` | accent soft; accent ink; focus-ring; radii 4px; surface-2 | Blue focus and accent match count; 4px field. | Neutral focus; 8px field; use a highlight token for matches. | P1 |
| FormulaEditor | `src/components/editor/formula-editor.tsx` | radii 4px; surface-2; hairline | 4px editor; dense monospace. | 8px editor; neutral focus; keep monospace. | P2 |
| HistoryControls | `src/components/editor/history-controls.tsx` | accent fill; radii 10px/full/4px default; surface-2; hairline | 10px/4px controls; accent active state. | 8px controls; neutral active; keep the compact size. | P2 |
| MentionMenu | `src/components/editor/mention-menu.tsx` | accent ink; radii 10px/4px default; surface-2; hairline | 10px menu; accent text. | 10px menu; neutral hover; accent only for matched text. | P2 |
| helper | `src/components/editor/page-editor-clipboard.tsx` | layout/behavior only | Calm content canvas, but selected blocks/images use loud accent outlines/tints and toolbars use mixed radii. | Neutral selection with handles; one floating toolbar language; 4px inline blocks, 8px controls. | P3 |
| EditorRowChrome | `src/components/editor/page-editor-motion.tsx` | shadow-2; shadow-1 | Shadow/motion chrome only. | Keep; align shadow with the overlay token. | P2 |
| PageEditor | `src/components/editor/page-editor.tsx` | focus-ring; shadow-2; radii 4px/full/4px default; surface-2; hairline | Notion-like block canvas; selected nodes use accent tint/outline; many floating layers. | Neutral selection with handles; one floating toolbar style; 4px inline blocks, 8px controls. | P2 |
| SlashMenuSurface, SlashMenu | `src/components/editor/slash-menu.tsx` | accent soft; accent ink; focus-ring; radii 4px; surface-2; hairline | Blue active row; 4px menu. | Neutral active row; 10px menu; accent only for icons. | P1 |
| SuggestionsControls | `src/components/editor/suggestions-controls.tsx` | radii 10px/full/4px default; surface-2; hairline | 10px surface; 4px chips. | 12px surface; 6px chips; neutral focus. | P2 |

## Database (25)

The densest surface. `ring-2 ring-accent` on selected/editing cells is the single biggest source of the blue-box feeling.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| BoardView | `src/components/database/board-view.tsx` | accent fill; focus-ring; shadow-1; radii 4px/10px; surface-2; hairline | 10px board cards; blue accents; different card language from the 6px Card primitive. | Use the card role token (12px); neutral column surface; accent only for the active card/primary. | P2 |
| ButtonCell | `src/components/database/button-cell.tsx` | focus-ring; radii 4px default; surface-2; hairline | 4px cell button; accent fill. | Action colour; 4px is fine inside a cell; neutral focus. | P2 |
| DatabaseActions | `src/components/database/database-actions.tsx` | accent fill; focus-ring; radii 4px default; surface-2 | Blue primary plus many icon actions. | One primary (New row), group the rest into a menu; 8px buttons. | P2 |
| PeekHeader, PeekRow, DatabasePeek | `src/components/database/database-peek.tsx` | accent ink; focus-ring; shadow-2; radii 4px; surface-2; hairline | Accent text and 4px rows; peek surface is close to the page. | Neutral peek surface, 8px rows, one accent link; stronger elevation. | P2 |
| DatabaseSurface | `src/components/database/database-surface.tsx` | layout/behavior only | No visual layer; async boundary. | No visual change; keep. | P3 |
| DatabaseView | `src/components/database/database-view.tsx` | focus-ring; radii 10px; surface; hairline | Mixed 10px/4px radii and many view-specific surfaces. | One shell and one toolbar; view settings in an overflow; 8px controls. | P2 |
| DateCell | `src/components/database/date-cell.tsx` | accent ink; focus-ring; radii 4px/4px default; surface-2; hairline | 4px cell input; accent today/selected. | Soft selection; neutral focus; keep density. | P2 |
| FormView | `src/components/database/form-view.tsx` | accent fill; focus-ring; radii 4px/10px/4px default; hairline | 10px form card; blue primary; 4px fields. | 12px card; 8px fields; one primary; neutral focus. | P2 |
| PropertyPanel, GalleryView | `src/components/database/gallery-view.tsx` | accent fill; focus-ring; radii 4px/10px; surface-2; hairline | 10px gallery cards; blue links/selection. | Use Card tokens; 12px; soft hover lift; neutral selection. | P2 |
| IconCell | `src/components/database/icon-cell.tsx` | focus-ring | 4px icon cell; focus ring. | Neutral focus; keep. | P2 |
| ListView | `src/components/database/list-view.tsx` | accent fill; focus-ring; radii 4px/10px/4px default; surface-2; hairline | 4px rows; blue accent on active rows. | 8px row radius; neutral active row with a left rail; keep density. | P2 |
| PeopleCell | `src/components/database/people-cell.tsx` | focus-ring; radii full/4px default; surface-2 | 4px cell; accent avatar ring. | Neutral avatar ring; 6px chip. | P2 |
| PlaceCell | `src/components/database/place-cell.tsx` | accent ink; focus-ring; radii 4px/4px default; surface-2; hairline | 4px cell; accent text. | Neutral link colour; keep. | P2 |
| PropertyOptionsEditor | `src/components/database/property-options-editor.tsx` | shadow-2; radii 14px/4px default; hairline | 14px popover with 4px colour chips; dense. | 12px popover; 6px chips; larger swatches; neutral focus. | P2 |
| PropertyPanel | `src/components/database/property-panel.tsx` | layout/behavior only | Dense spreadsheet chrome with 4px cells and blue selection/focus rings; views use different card radii. | Shared database shell; soft selection fill; neutral focus; 8px toolbar; 12px cards; status hues only for status. | P3 |
| RelationCell | `src/components/database/relation-cell.tsx` | focus-ring; radii 4px default; surface-2; hairline | 4px cell; accent chips. | 6px chips; soft selected fill. | P2 |
| StatusCell | `src/components/database/status-cell.tsx` | focus-ring; radii 4px | 4px cell; status hues. | Keep status hues; 6px chip; neutral focus. | P2 |
| TableView | `src/components/database/table-view.tsx` | accent fill; focus-ring; shadow-1; radii 4px/10px/4px default; surface-2; hairline | Dense spreadsheet chrome; 4px cells; blue selection rings; many borders. | One `DatabaseShell`; sticky header; neutral row hover; soft selected fill; 8px toolbar controls. | P1 |
| CalendarSkeleton, TimelineSkeleton, ChartSkeleton +3 | `src/components/database/timeline-chart-views.tsx` | accent fill; accent ink; focus-ring; radii 4px/10px/full/4px default; surface-2; hairline | Dense spreadsheet chrome with 4px cells and blue selection/focus rings; views use different card radii. | Shared database shell; soft selection fill; neutral focus; 8px toolbar; 12px cards; status hues only for status. | P2 |
| PropertyHeader, Cell, AddPropertyForm | `src/components/database/view-parts.tsx` | accent fill; accent border; accent ring; focus-ring; radii 3px/4px/10px/4px default; surface-2; hairline | Selected and editing cells use `ring-2 ring-accent`; focus adds `ring-2 ring-ring/60`. Selection and focus are both blue rings. | Selected = soft fill; focus = neutral ring; 4px cells are fine for density, but standalone fields 8px. | P1 |
| helper | `src/components/database/view-renderers.tsx` | layout/behavior only | Dense spreadsheet chrome with 4px cells and blue selection/focus rings; views use different card radii. | Shared database shell; soft selection fill; neutral focus; 8px toolbar; 12px cards; status hues only for status. | P3 |
| SettingsPopoverContent, ColorChips, FilterLeafRow +3 | `src/components/database/view-settings-model.tsx` | radii 4px default; surface-2; hairline | 4px filter/colour chips; dense rows. | 6px chips; 8px rows; neutral focus. | P2 |
| ViewSettings | `src/components/database/view-settings.tsx` | radii 4px default; surface-2; hairline | 4px controls inside a popover. | 8px controls; 12px popover; neutral focus. | P2 |
| ViewIcon, DatabaseViewTabs | `src/components/database/view-tabs.tsx` | focus-ring; radii 4px default; surface-2; hairline | 4px tabs; blue active state. | 8px tab radius; neutral active with a bottom rail; accent only for the icon. | P2 |
| DatabaseViewToolbar | `src/components/database/view-toolbar.tsx` | focus-ring; radii 10px/4px default; surface-2; hairline | 10px toolbar surface; 4px controls. | 12px toolbar; 8px controls; group secondary actions. | P2 |

## Tickets (10)

A parallel card/drawer system with 14/10px radii and blue primary, not the shared 6px Card primitive.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| TicketsWorkspace | `src/components/tickets-workspace.tsx` | layout/behavior only | Screen wrapper; inherits the ticket card/drawer styles. | Use the shared ticket shell; do not add new surface styles here. | P3 |
| EmptyTicketsState | `src/components/tickets/empty-tickets.tsx` | focus-ring; radii 14px; hairline | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| ArchiveRow, TicketArchiveView | `src/components/tickets/ticket-archive-view.tsx` | radii 10px; surface-2; hairline | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| LabelChip, StatusPill, SlaChip +3 | `src/components/tickets/ticket-bits.tsx` | radii full/4px default | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| TicketBulkActions | `src/components/tickets/ticket-bulk-actions.tsx` | radii 10px; surface-2; hairline | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| TicketComposerForm, TicketComposer, TicketComposerDialog | `src/components/tickets/ticket-composer.tsx` | radii 14px; surface; hairline | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| TicketDescription | `src/components/tickets/ticket-description.tsx` | radii 6px/10px; surface-2; hairline | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| TicketDrawerBody, TicketDrawer | `src/components/tickets/ticket-drawer.tsx` | accent border; accent focus; focus-ring; radii 4px/6px/10px/full; surface-2; hairline | Hand-rolled inputs with `focus:border-accent`; 4/6/10px controls; dense drawer. | Field/Input 8px; neutral focus; 12px cards; sticky footer with one primary. | P1 |
| BoardCard, TicketListView, TicketBoardView +1 | `src/components/tickets/ticket-view-renderers.tsx` | accent border; focus-ring; shadow-2; shadow-1; radii 4px/10px/14px; surface-2; hairline | Ticket surfaces use 14/10px cards and blue primary, drifting from the 6px Card primitive; drawers are dense. | Use Card 12px, Section/Field, 8px controls, one primary, status tones, sticky drawer footer. | P2 |
| TicketsToolbar | `src/components/tickets/tickets-toolbar.tsx` | layout/behavior only | Toolbar delegates to shared controls; dense filter row. | One toolbar; 8px controls; group secondary filters into a menu. | P3 |

## Projects, cycles & gallery (6)

Card radius and hand-rolled inputs drift from the kit; status colours are strong but not always consistent.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| CycleCard, CyclesBoard | `src/components/cycles-board.tsx` | accent fill; accent ink; accent border; focus-ring; radii 14px/4px default; surface-2; hairline | 14px cards and blue accents drift from the 6px Card primitive; detail forms use hand-rolled inputs. | Card role 12px; Field/Input 8px; status hues; one primary; muted timeline. | P2 |
| HomeGallery | `src/components/home-gallery.tsx` | focus-ring; radii 4px/full; surface; hairline | 14px cards and blue accents drift from the 6px Card primitive; detail forms use hand-rolled inputs. | Card role 12px; Field/Input 8px; status hues; one primary; muted timeline. | P2 |
| ProjectActions | `src/components/project-actions.tsx` | accent border; accent focus; focus-ring; radii 10px/4px default; surface; hairline | 14px cards and blue accents drift from the 6px Card primitive; detail forms use hand-rolled inputs. | Card role 12px; Field/Input 8px; status hues; one primary; muted timeline. | P2 |
| ProjectDetail | `src/components/project-detail.tsx` | accent border; accent focus; focus-ring; radii 10px/14px/full/4px default; surface-2; hairline | 14px cards; several hand-rolled inputs with `focus:border-accent`; dense metadata. | Card 12px; Field/Input 8px; neutral focus; one primary; move metadata into a sidebar. | P1 |
| ProjectGantt | `src/components/project-gantt.tsx` | accent fill; accent ink; focus-ring; radii 3px/14px/4px default; surface-2; hairline | 14px cards and blue accents drift from the 6px Card primitive; detail forms use hand-rolled inputs. | Card role 12px; Field/Input 8px; status hues; one primary; muted timeline. | P2 |
| ProjectCardTile, ProjectsBoard | `src/components/projects-board.tsx` | accent border; accent focus; focus-ring; radii 6px/14px/4px default; surface-2; hairline | 14px cards; hand-rolled inputs with `focus:border-accent`; blue accents. | Card 12px; Field/Input 8px; status hues; one primary; muted secondary actions. | P1 |

## Collaboration, search & chat (12)

Search focus and match highlights use the same blue as links, so matches look like links and focus looks like selection.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| Backlinks | `src/components/backlinks.tsx` | accent fill; focus-ring; radii 3px/4px/6px; surface-2; hairline | Blue focus borders and blue search highlights; selected comments/rows use blue rings; chat uses accent for too many parts. | Neutral focus; amber/neutral search highlight; soft selected fill; accent only for send/own message. | P2 |
| ChatAnswerItems | `src/components/chat-answer-menu.tsx` | accent ink | Blue focus borders and blue search highlights; selected comments/rows use blue rings; chat uses accent for too many parts. | Neutral focus; amber/neutral search highlight; soft selected fill; accent only for send/own message. | P2 |
| ChatFab | `src/components/chat-fab.tsx` | accent fill; focus-ring; shadow-2; radii full | Blue focus borders and blue search highlights; selected comments/rows use blue rings; chat uses accent for too many parts. | Neutral focus; amber/neutral search highlight; soft selected fill; accent only for send/own message. | P2 |
| ChatModelPicker | `src/components/chat-model-picker.tsx` | focus-ring; radii 4px/full; surface-2; hairline | Blue focus borders and blue search highlights; selected comments/rows use blue rings; chat uses accent for too many parts. | Neutral focus; amber/neutral search highlight; soft selected fill; accent only for send/own message. | P2 |
| TypingIndicator, ChatPanelSkeleton, ChatEmptyState +2 | `src/components/chat-panel.tsx` | accent fill; accent soft; accent ink; focus-ring; shadow-2; radii 3px/4px/6px/10px/full; surface-2; hairline | Blue send button and blue-connected states; mixed 3/4/6/10px radii. | Neutral message bubbles; action colour for send; 12px bubbles; neutral focus. | P1 |
| CommandPalette | `src/components/command-palette.tsx` | accent fill; accent soft; accent ink; focus-ring; radii 3px/4px; surface-2; hairline | Blue active row; 4px rows; global blue focus outline. | Neutral active row; 8px rows; 10px dialog; accent only for icons. | P1 |
| CommentPanel | `src/components/comment-panel.tsx` | accent soft; accent ink; accent border; accent ring; focus-ring; radii 3px/6px/10px/4px default; surface-2; hairline | Selected comment uses `border-accent bg-accent-soft ring-2 ring-accent/30`; blue composer. | Soft selected fill; 12px panel; neutral focus; accent only for send. | P1 |
| CommentReactions | `src/components/comment-reactions.tsx` | layout/behavior only | Reaction pills delegate to Button; selected state can pick up accent. | Soft selected fill; 6px pills; neutral focus. | P3 |
| DeferredBacklinks | `src/components/deferred-backlinks.tsx` | hairline | Blue focus borders and blue search highlights; selected comments/rows use blue rings; chat uses accent for too many parts. | Neutral focus; amber/neutral search highlight; soft selected fill; accent only for send/own message. | P2 |
| DeferredCommentPanel | `src/components/deferred-comment-panel.tsx` | layout/behavior only | Blue focus borders and blue search highlights; selected comments/rows use blue rings; chat uses accent for too many parts. | Neutral focus; amber/neutral search highlight; soft selected fill; accent only for send/own message. | P3 |
| QuickFind | `src/components/quick-find.tsx` | accent fill; accent soft; radii 3px/4px; surface-2; hairline | Auto-focused input gets the global blue outline; active rows use `bg-accent-soft`; 4px rows. | Use `SearchField` with neutral focus; 8px rows; soft active fill; 10px dialog. | P1 |
| SearchResults | `src/components/search-results.tsx` | accent soft; accent ink; focus-ring; radii 3px/10px; surface-2; hairline | Blue match highlights; 10px result cards; accent links. | Amber/neutral highlight; 12px cards; neutral focus; accent only for links. | P1 |

## Settings, account & security (26)

Many forms and cards. The visual issues are repetition and drift rather than broken layout.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| AboutDialog | `src/components/about-dialog.tsx` | accent fill; focus-ring; shadow-2; radii 4px/10px/14px/4px default; surface-2; hairline | Blue logo tile; mixed 4/10/14px radii; blue primary action. | Ink mark; 12px dialog; one primary; neutral focus. | P1 |
| ProviderCard, PromptCard, BudgetUsageBar | `src/components/ai-settings-providers.tsx` | accent ring | Selected provider card uses `ring-1 ring-accent`; 6px cards. | Neutral selected border or soft fill; 12px card; accent only for status. | P1 |
| AiSettings | `src/components/ai-settings.tsx` | radii 6px; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| ScopeChip, ScopeChips, ScopePicker +5 | `src/components/api-token-manager.tsx` | radii 3px/4px/6px; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| ApiTokensPanel | `src/components/api-tokens-panel.tsx` | layout/behavior only | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P3 |
| AuthFormView, AuthForm | `src/components/auth-form.tsx` | accent ink; focus-ring; radii 3px/full; surface-2 | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| AuthShell | `src/components/auth-shell.tsx` | accent soft; focus-ring; shadow-2; shadow-1; radii 6px/10px/full; surface; hairline | Blue `bg-accent-soft` blur blob; 6/10px cards; generic auth panel. | Replace the blob with an editorial brand panel or quiet pattern; ink mark; 12px card; one primary. | P1 |
| DangerAction, DangerZone | `src/components/danger-zone.tsx` | layout/behavior only | Destructive surface delegates to shared primitives; red is appropriate but can feel flat. | Soft danger surface; 12px card; one destructive action; neutral focus. | P3 |
| DiagnosticsDialog | `src/components/diagnostics-dialog.tsx` | accent fill; focus-ring; shadow-2; radii 14px/4px default; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| EmailForm, EmailSettings | `src/components/email-settings.tsx` | radii 6px; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| InviteAcceptButton | `src/components/invite-accept-button.tsx` | layout/behavior only | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P3 |
| LabelManager | `src/components/label-manager.tsx` | accent ring; radii 4px/6px/full; surface-2; hairline | Active label uses `ring-2 ring-accent ring-offset-1`; 4/6px chips. | Soft selected fill or left rail; 6px chips; neutral focus. | P1 |
| MembersManager | `src/components/members-manager.tsx` | accent ink; focus-ring; radii 4px/6px; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| NotificationPreferencesForm | `src/components/notification-preferences-form.tsx` | focus-ring; radii 4px/6px; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| CopyButton, ScopeTags, OAuthAppCard +3 | `src/components/oauth-app-manager.tsx` | focus-ring; radii 3px/4px; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| SessionListItem, SessionList, SessionsManager | `src/components/sessions-manager.tsx` | layout/behavior only | List rows delegate to shared primitives; no distinct style of its own. | Use Section/Card; 12px cards; status tones; 8px controls. | P3 |
| ShareSection, Switch, PublishSettingsSection +3 | `src/components/share-dialog.tsx` | accent fill; accent border; focus-ring; shadow-2; radii 4px/6px/14px/full; surface-2; hairline | Blue checkbox/switch and 4/6px controls inside a 14px dialog. | Action colour for checked state; 8px controls; 14px dialog; one primary. | P1 |
| ShortcutsDialog | `src/components/shortcuts-dialog.tsx` | focus-ring; shadow-2; radii 14px/4px default; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| TeamspaceManager | `src/components/teamspace-manager.tsx` | accent fill; focus-ring; radii 4px/10px; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| TrashList | `src/components/trash-list.tsx` | radii 10px/14px; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| StepIndicator, CopyButton, SecretBlock +3 | `src/components/two-factor-manager.tsx` | accent soft; accent ink; accent border; focus-ring; radii 3px/4px/6px/full; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| VersionHistoryPanel | `src/components/version-history-panel.tsx` | focus-ring; shadow-2; radii 10px/full/4px default; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| VersionHistory | `src/components/version-history.tsx` | focus-ring; radii 4px default; surface-2 | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| EndpointRow, WebhookManager | `src/components/webhook-manager.tsx` | radii 3px/6px; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| AccessList, WhoHasAccess | `src/components/who-has-access.tsx` | focus-ring; radii 4px/10px/full/4px default; surface-2; hairline | Many 6px cards and 4px fields; blue primary; some hand-rolled `focus:border-accent`; uneven section spacing. | Section + Card 12px + Field/Input 8px; neutral focus; danger red; consistent save bar. | P2 |
| CreateWorkspaceButton, EditWorkspaceButton, WorkspaceDialog | `src/components/workspace-dialog.tsx` | accent ring; focus-ring; radii 4px/6px; surface-2; hairline | Selected workspace icon uses `bg-surface-2 ring-1 ring-accent`; 4/6px controls. | Neutral selected tile; 8px controls; accent only for the check. | P1 |

## App surfaces & utilities (3)

Mixed surfaces and one-off compositions; good candidates for new composites.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| AuditFeed | `src/components/audit-feed.tsx` | accent fill; radii 4px/6px/full; surface-2; hairline | Mixed hand-rolled surfaces; some use accent/radius outside the shared primitives. | Move repeated surfaces into Card/Section/Field; 12px cards, 8px controls, neutral focus. | P2 |
| NotionImportDialog | `src/components/notion-import-dialog.tsx` | accent fill; accent soft; accent ink; accent border; radii 6px/full; surface-2; hairline | Mixed hand-rolled surfaces; some use accent/radius outside the shared primitives. | Move repeated surfaces into Card/Section/Field; 12px cards, 8px controls, neutral focus. | P2 |
| PromptDialog | `src/components/prompt-dialog.tsx` | accent fill; accent border; accent focus; focus-ring; shadow-2; radii 14px/4px default; surface-2; hairline | Mixed hand-rolled surfaces; some use accent/radius outside the shared primitives. | Move repeated surfaces into Card/Section/Field; 12px cards, 8px controls, neutral focus. | P2 |

## Infrastructure & utilities (12)

No visual layer. Keep these out of the visual critique, but add any that render UI to the gallery.

| Component(s) | File | Current style | Why it feels off | Best recommendation | Priority |
|---|---|---|---|---|---|
| ActionErrorGuard | `src/components/action-error-guard.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| DeferredMount | `src/components/deferred-mount.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| DesktopShellBridge | `src/components/desktop-shell-bridge.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| DesktopThemeSync | `src/components/desktop-theme-sync.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| ReadPrintStyles, DocRendererSkeleton, DocRendererError +1 | `src/components/doc-renderer.tsx` | accent ink; focus-ring; radii 3px/4px/6px; surface-2; hairline | Long-form reading surface; links use accent; code/table radii are 4/6px; otherwise calm. | Use the link token; 8px code/table; keep the reading measure and typography. | P2 |
| LocalTime | `src/components/local-time.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| Markdown, InlineMarkdown | `src/components/markdown.tsx` | accent ink; focus-ring; radii 3px/6px; surface-2; hairline | Inline markdown links use accent; 3/6px code/chips; otherwise fine. | Use the link token; 6px code; neutral focus. | P2 |
| OfflineIndicator | `src/components/offline-indicator.tsx` | radii 10px/4px default; surface-2; hairline | 10px banner with 4px controls; status colour is not distinct from the surface. | 10px banner; status/info colour; 8px controls. | P2 |
| OfflineProvider | `src/components/providers/offline-provider.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| UndoRedoProvider | `src/components/providers/undo-redo-provider.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| ThemeProvider | `src/components/theme-provider.tsx` | layout/behavior only | No visual layer; behavior/provider only. | No visual change; keep. Not a design-system component. | P3 |
| UndoButton | `src/components/toast-undo.tsx` | accent fill; accent ink; focus-ring; radii 4px | Undo action uses accent fill, competing with the toast status. | Neutral text button for Undo; status colour on the icon only. | P2 |

## Appendix A — Route/page components (63)

These are screen compositions, not reusable primitives. They inherit the issues above; they should consume the composites rather than hand-roll new ones.

- `src/app/app/page.tsx`
- `src/app/dev/ui/design-gallery.tsx`
- `src/app/dev/ui/motion-gallery.tsx`
- `src/app/dev/ui/page.tsx`
- `src/app/error.tsx`
- `src/app/invite/[token]/loading.tsx`
- `src/app/invite/[token]/page.tsx`
- `src/app/invite/teamspace/[token]/loading.tsx`
- `src/app/invite/teamspace/[token]/page.tsx`
- `src/app/layout.tsx`
- `src/app/login/page.tsx`
- `src/app/not-found.tsx`
- `src/app/oauth/authorize/page.tsx`
- `src/app/page.tsx`
- `src/app/s/[token]/loading.tsx`
- `src/app/s/[token]/page.tsx`
- `src/app/signup/page.tsx`
- `src/app/w/[slug]/[pageId]/loading.tsx`
- `src/app/w/[slug]/[pageId]/page.tsx`
- `src/app/w/[slug]/audit/loading.tsx`
- `src/app/w/[slug]/audit/page.tsx`
- `src/app/w/[slug]/cycles/loading.tsx`
- `src/app/w/[slug]/cycles/page.tsx`
- `src/app/w/[slug]/inbox/loading.tsx`
- `src/app/w/[slug]/inbox/page.tsx`
- `src/app/w/[slug]/layout.tsx`
- `src/app/w/[slug]/library/loading.tsx`
- `src/app/w/[slug]/library/page.tsx`
- `src/app/w/[slug]/loading.tsx`
- `src/app/w/[slug]/page.tsx`
- `src/app/w/[slug]/projects/[projectId]/loading.tsx`
- `src/app/w/[slug]/projects/[projectId]/page.tsx`
- `src/app/w/[slug]/projects/loading.tsx`
- `src/app/w/[slug]/projects/page.tsx`
- `src/app/w/[slug]/roadmap/loading.tsx`
- `src/app/w/[slug]/roadmap/page.tsx`
- `src/app/w/[slug]/search/loading.tsx`
- `src/app/w/[slug]/search/page.tsx`
- `src/app/w/[slug]/settings/audit/loading.tsx`
- `src/app/w/[slug]/settings/audit/page.tsx`
- `src/app/w/[slug]/settings/billing/loading.tsx`
- `src/app/w/[slug]/settings/billing/page.tsx`
- `src/app/w/[slug]/settings/data/loading.tsx`
- `src/app/w/[slug]/settings/data/page.tsx`
- `src/app/w/[slug]/settings/loading.tsx`
- `src/app/w/[slug]/settings/move/loading.tsx`
- `src/app/w/[slug]/settings/move/page.tsx`
- `src/app/w/[slug]/settings/notifications/loading.tsx`
- `src/app/w/[slug]/settings/notifications/page.tsx`
- `src/app/w/[slug]/settings/page.tsx`
- `src/app/w/[slug]/settings/prompts/loading.tsx`
- `src/app/w/[slug]/settings/prompts/page.tsx`
- `src/app/w/[slug]/settings/settings-nav.tsx`
- `src/app/w/[slug]/settings/tokens/loading.tsx`
- `src/app/w/[slug]/settings/tokens/page.tsx`
- `src/app/w/[slug]/templates/loading.tsx`
- `src/app/w/[slug]/templates/page.tsx`
- `src/app/w/[slug]/tickets/archive/loading.tsx`
- `src/app/w/[slug]/tickets/archive/page.tsx`
- `src/app/w/[slug]/tickets/loading.tsx`
- `src/app/w/[slug]/tickets/page.tsx`
- `src/app/w/[slug]/trash/loading.tsx`
- `src/app/w/[slug]/trash/page.tsx`

## Appendix B — What to build next

1. **Foundations:** split `--accent` into `--color-action`, `--color-link`, `--color-focus`, `--color-selection`, `--color-highlight`; add `--radius-control`, `--radius-card`, `--radius-overlay`, `--radius-chip`.
2. **One focus system:** a neutral ring with a soft halo; remove the duplicate outline/border from `.focus-ring` and `focus:border-accent`.
3. **One selection language:** soft fill and/or a left rail; no `ring-2 ring-accent` on selected cells, comments, labels, icons, avatars or toolbar items.
4. **New composites:** `SearchField`, `PageHeader`, `DatabaseShell`, `SettingsSection`, `BrandLockup`, `EntityCard`, `EmptyStatePattern`.
5. **Gallery:** add Foundations, Composites, Patterns, and a state matrix to `/dev/ui`; include light/dark/high-contrast screenshots.
6. **Migration order:** tokens → Button/Input/Card → database cell/table → search/command palette → sidebar/page header → settings/tickets/projects → editor toolbars → gallery.
