# Noema — the film, on paper

The production document behind `out/noema-promo.mp4`. It exists so the film can
be argued with: every shot has a reason, every claim maps to a feature that
actually works, and the timing is written down rather than felt.

- **Runtime** 4,306 frames @ 30 fps = **2 min 23 s**, 1920×1080.
- **Deliverables** `out/noema-promo.mp4` (with music) and
  `out/noema-promo-nobgm.mp4` (the same cut without the music bed — the sound
  effects stay, so it still cuts; for a venue or a re-score).
- **Source of truth** `src/noema/Main.tsx` — `ORDER` is the edit, `SFX` is the
  sound, `CHAPTERS` is the copy.

---

## 0 — Product brief

**The product.** Noema is a local-first, self-hosted workspace: notes, docs and
databases on one page model, plus tickets, cycles, projects, a roadmap, workspace
chat and sharing — and it installs as a desktop app with nothing else to install.

**Who the film is for.** Someone who already knows the category (Notion, Linear,
Height) and is deciding whether to run this instead. They do not need an
explanation of what a block is. They need to see, quickly, that the *breadth* is
real and the *craft* is there.

**What the film has to do.** In one pass: establish the category, prove the four
surfaces that make up the workspace (write, structure, ship, think together),
prove that it is yours to run, and land the name. Nothing may be claimed that the
repository does not do — this is a film for an open-source project, so an
over-claim is a bug report waiting to happen.

**Must-show inventory** (the user's list, all covered): the editor · databases ·
ticket · project · workspace · rules (conditional formatting) · labels ·
milestone · progression · cycles · roadmap · chat · comments · versions · sharing
· search · settings · the desktop installer · import/export.

**Execution constraints.**

| Constraint | Decision |
| --- | --- |
| Duration | ~2 min; landed at 2:23 because a full tour that skipped an area would fail the brief |
| Aspect / fps | 1920×1080, 30 fps — the frame a README, a landing page and a slide deck all accept |
| Language | English only. The app ships five locales; a film is not the place to prove it |
| Data | The seeded demo workspace only — fictional people, fictional projects. No customer data, no real names |
| Claims | Every caption describes something visible in that shot |
| Rights | The app is MIT. The film's camera is adapted from video-shotcraft (**Copyright 2026 Wei Yihao, Apache-2.0**), as are the music and SFX. No licensed footage, no stock music |

---

## 1 — Visual direction

**The premise.** The film should look like it came out of the app. That is not a
style choice, it is a constraint that solves a lot of problems: a product film
made of real screenshots on a stage borrowed from the product's own tokens cannot
drift into looking like a different, better product.

**Palette** — taken from `src/app/tokens.css`, not invented:

| Token | Value | Used for |
| --- | --- | --- |
| canvas | `#ffffff` | the stage behind every shot |
| sidebar | `#f7f7f5` | the public-page backdrop |
| surface | `#f1f1ef` | plates behind text |
| border | `#e9e9e7` | caption and card outlines |
| ink | `#37352f` | all film copy |
| muted | `#6b6a65` | secondary copy |
| accent | `#1a75d2` | the mark, chapter rules, one highlight per shot |
| dark | `#191919` / `#202020` | the dark-mode chapter |
| tag palette | 10 hues | label and status pills, exactly the app's |

**Type.** The app's own stack (Segoe UI / system UI). Sizes are film sizes, not
app sizes: captions **58px**, auxiliary lines **34px**, chapter titles **132px**,
the wordmark **220px**. The skill's rule Q11 sets the floor at 5.2% of the frame
(56px) for anything the viewer must read; nothing in the film is below it.

**Motion voice.** Both of the app's easing curves, used for what the app uses them
for:

- `--ease-smooth: cubic-bezier(0.2, 0, 0, 1)` — every element that enters,
  every camera move that has to feel *mechanical*.
- `--ease-spring: cubic-bezier(0.34, 1.32, 0.64, 1)` — the settle at the end of
  an arrival: a ticket card landing on a board, the wordmark pressing in.
- A third curve exists for the camera alone (`cubic-bezier(0.33, 0, 0.15, 1)`),
  slower out of the gate, because a push-in that starts at full speed reads as a
  zoom rather than weight.

**The stage.** The app's canvas, full-bleed, with 3% film grain multiplied over
it. The grain is the one thing in the film that is *not* from the product, and it
is there because large white fields read as flat vector without it.

**What the film does not do.** No drop-shadow bezels, no fake browser chrome, no
laptop mockups, no animated cursors wandering a screen. The screenshots are the
app; they are presented as the app.

---

## 2 — Feature → shot mapping

Each row is a capability from the brief, the shot that carries it, and the
technique that shot borrows from the skill's card library. No technique is the
protagonist twice (rule P4) except the chapter card, which is the film's
designated breath.

| # | Feature | Shot | Technique |
| --- | --- | --- | --- |
| 1 | — (hook) | `hook` | `beat-cut-moves` — three surfaces, one beat each |
| 2 | The product | `brand` | `brand-ink-open` |
| 3 | Block editor | `editor` | `document-typewriter-reveal` |
| 4 | Block menu | `slash` | `chip-grid-single-select-blackout` |
| 5 | Quick find | `quickfind` | `type-and-filter` |
| 6 | Seven views | `views` | `beat-cut` over real view captures |
| 7 | Typed properties, formulas, rollups, relations | `properties` | `row-embed` |
| 8 | **Rules** (conditional formatting) | `rules` | `segmented-thumb-hero` |
| 9 | Row peek | `peek` | `depth-layer-moves` |
| 10 | Tickets: keys, labels, estimates, saved views | `ticketsList` | `list-stack-press` |
| 11 | Board | `board` | `deck-deal-flyin` |
| 12 | Ticket drawer: sub-tickets, relations, activity | `drawer` | `product-card-progressive-assemble` |
| 13 | **Cycles**, burndown, velocity | `cycles` | `draw-svg-trace` + `gauge-readout-moves` |
| 14 | **Projects** and progress | `projects` | `gauge-readout-moves` |
| 15 | **Milestones** | `project` | `timeline-travel` |
| 16 | Roadmap | `roadmap` | `steep-tilt-glide` |
| 17 | Workspace chat | `chat` | `canvas-materialize-moves` |
| 18 | Comments and reactions | `comments` | `collab-cursor-moves` |
| 19 | Version history | `versions` | `speed-ramp-freeze` |
| 20 | Sharing and permissions | `share` | `card-flip-reveal` |
| 21 | Published page | `public` | `PageShot` |
| 22 | Members, roles, invites, tokens | `settings` | `list-reveal` |
| 23 | Dark mode | `dark` | `theme-switch-moves` |
| 24 | Desktop installer, import/export | `desktop` | `terminal-3d` |
| 25 | Everything at once | `outro` | `outro-group-photo-launch` |

**Labels** are carried by `ticketsList`, `board` and `drawer` — every label pill
in those shots is a real `option-chip` in the capture, not a drawn one.
**Progression** is carried by `cycles` (burndown + committed %), `projects`
(progress) and `project` (milestone states). **Workspace** is carried by every
shot (the sidebar is always real) plus `settings`.

---

## 3 — Storyboard

`from` is the absolute frame; the sound column lists only the cues that define
the beat. Everything here is derived from `ORDER` in `src/noema/Main.tsx`.

| Shot | from | dur | Content | Camera | Caption | Beat |
| --- | --- | --- | --- | --- | --- | --- |
| `hook` | 0 | 72 | board → burndown → chat | three 24f cuts, each pushing in | — | whoosh ×3 |
| `brand` | 72 | 168 | the mark and the one-line pitch | static, hold ≥1s | — | riser → impact → shimmer |
| `cardWrite` | 240 | 84 | chapter 01 | static, hold ≥1s | — | page turn |
| `editor` | 324 | 240 | the handbook: callout, toggles, code, tables | 1.30 → 1.16, pan down the page | The block editor — headings, callouts, toggles, code, tables | typewriter, keyboard |
| `slash` | 564 | 132 | the `/` menu, filtered, one block chosen | push into the menu | Type / for any block | click, select |
| `quickfind` | 696 | 138 | ⌘P, type "roadmap", jump | slight push | Ctrl / ⌘ P — jump to any page | tap, whoosh |
| `cardStructure` | 834 | 84 | chapter 02 | static, hold ≥1s | — | page turn |
| `views` | 918 | 288 | table → board → timeline → calendar → gallery → chart → list | seven 40f beats | a per-beat caption naming the view | sweep + six snaps |
| `properties` | 1206 | 150 | the rollup property's menu over the roadmap table | drift right | Typed properties — relations, rollups and computed columns | click, confirm |
| `rules` | 1356 | 150 | a real rule authored: Status *is* Done | push into the panel | Conditional formatting — rules colour the rows | tap, confirm |
| `peek` | 1506 | 130 | a row opened over the table | push right | Open any row without leaving the table | whoosh, pop |
| `cardShip` | 1636 | 84 | chapter 03 | static, hold ≥1s | — | page turn |
| `ticketsList` | 1720 | 162 | the tracker's list: keys, labels, estimates, views | push + pan down | Tickets — keys, labels, estimates, saved views | whoosh, sweep |
| `board` | 1882 | 198 | 34 real cards dealt onto the board | slow drift | Board — every ticket, in its column | impact + four pops |
| `drawer` | 2080 | 172 | the drawer: labels, relations, sub-tickets, activity | push right | The drawer — sub-tickets, relations, activity | whoosh, pop |
| `cycles` | 2252 | 192 | commitment, burndown, velocity | push, with two readouts | Cycles — commitment, burndown and velocity | scan, tick, confirm |
| `projects` | 2444 | 150 | progress, owners, target dates | drift | Projects — progress, owners and target dates | sweep, confirm |
| `project` | 2594 | 144 | milestones planned → done | push + pan | Milestones — planned → in progress → done | slide, notify |
| `roadmap` | 2738 | 144 | the workspace Gantt | push into the populated cluster | The workspace roadmap | air whoosh, sweep |
| `cardTogether` | 2882 | 84 | chapter 04 | static, hold ≥1s | — | page turn |
| `chat` | 2966 | 176 | a question, an answer drawn from the pages | push right | Ask your workspace — it answers from your own pages | click, keyboard, pop |
| `comments` | 3142 | 126 | comment anchored to a selection | push | Comment on the text itself | tap, pop |
| `versions` | 3268 | 120 | history, and a restore | drift | Every save, restorable | tick, confirm |
| `share` | 3388 | 132 | link, roles, publish | push | Share with a link — or one member at a time | click, sweep |
| `public` | 3520 | 108 | the page a visitor gets | slow push | What a visitor sees | whoosh |
| `cardOwn` | 3628 | 84 | chapter 05 | static, hold ≥1s | — | page turn |
| `settings` | 3712 | 132 | members, roles, invites | push + pan | Members, roles and invites | sweep, click |
| `dark` | 3844 | 126 | the same workspace, dark | push | The same workspace, dark | transition, sweep |
| `desktop` | 3970 | 150 | the installer, over a dimmed settings page | static, terminal typed in | One installer. Nothing else to install. | machine, confirm, impact |
| `outro` | 4120 | 186 | every surface's element assembles around the mark | static, hold ≥1s | (the lockup) | riser → impact → sparkle |

**Energy arc.** Low for the first 240 frames (three flashes, then a held mark),
then a climb: the chapters get progressively denser, the board is the loudest
single beat at 1882, and the last 186 frames are the peak — a launch photo, not a
fade. Both ends hold a full second after the last element moves (rule R1), and so
does every chapter card.

---

## 4 — Assets

No texture is hand-made. `video/scripts/capture.mjs` drives the installed Edge
against the seeded app and writes, per surface, a **2× PNG** and a `layout.json`
holding the page box and the box of every element a shot animates separately.

43 surfaces are captured; the film uses 31 of them plus 6 cutout classes (the
sidebar, a peek drawer, a cycle card, a project card, and 34 board cards). The
2× capture is the reason a push-in stays sharp: at 1×, a camera move resolves
against pixels that were only ever meant for a still.

## 5 — Build

Six scene engines, not thirty bespoke shots: `PageShot` (a real page under the
2.5D camera), `HookCut`, `BrandOpen`, `BoardDeal`, `Readout`, `Outro`, plus the
`TitleCard` breath and two small overlays (`Claim`, `Terminal`). `PageCam` is
adapted from video-shotcraft and keeps its most valuable detail — magnification is
the CSS `zoom` property, not `scale()` in the transform chain, because `scale()`
makes Chromium rasterise at layout size and GPU-upscale, which is what makes most
screenshot push-ins look soft.

## 6 — Sound

A single electronic bed (`bgm-tech-house`) at −13 dB under the picture, and 73
cues drawn from 30 files, all pinned to frames in a declarative table. The rules
the design follows:

- Cuts get air (whooshes), arrivals get an impact or a pop, panels get a tap.
- The 34 cards dealt onto the board get **four** pops, not 34 — a hit per card is
  a machine gun, and the eye already reads the stagger.
- Nothing with a game timbre: no coin, no laser, no UI bleep motif.
- Every cue is placed by frame in `Main.tsx`, so retiming a shot moves its sound
  with it instead of leaving the two out of sync.

There is no audio offset to compensate for (S5). The skill's warning is about
pipelines that mix a separately recorded track and have to measure the latency;
here the music and every cue are mixed by Remotion inside the same timeline as the
picture, so a cue written at frame *N* is at frame *N*. The only judgement left is
where *N* should be, and that is the table.

## 7 — Review

Checked against the skill's rulebook before release:

| Rule | Result |
| --- | --- |
| R1 hold ≥1s after key information | The mark (both ends) and all five chapter cards hold a full second. The cards are 84 frames and their fade window is anchored to the *end of the shot* rather than to a fixed frame number — hard-coding it cut the card off mid-fade and left the title holding 0.8s |
| R2 acceleration, not constant speed; a rest after the run | The board accelerates its stagger and rests 0.5s once full |
| Q1 real screenshots only | Every frame is a capture; no redrawn UI |
| Q2 rasterise for 3D, CSS `zoom` not `scale()` | `PageCam` uses `zoom` for both the flat and the 3D path |
| Q9 land in real slots | Fly-ins read their destination from the capture's `layout.json` |
| Q11 captions ≥56px, auxiliary ≥32px | 58px captions, and 34px for everything else the viewer must read — auxiliary lines, readout labels, terminal output, the chapter kicker |
| S1 no game-SFX timbres | Cinematic/UI vocabulary only |
| S2 cues pinned in a table | `SFX` in `Main.tsx` |
| P4 one technique as protagonist, once | 25 distinct techniques, chapter card excepted |
| — no over-claim | An independent review read every caption against its own frame. It caught three that the picture did not support and all three were fixed: `chat` promised citations while the panel said "No sources"; `properties` named formulas and rollups while the frame showed the column-visibility popover; `board` promised a drag the shot never performs. It also caught `ticketsList` photographing the board (a persisted view preference the capture had not pinned), which is now the List view. The `rules` shot authors a real rule rather than photographing an empty panel |
