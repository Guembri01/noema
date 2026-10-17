# Noema — the film, on paper

The production document behind `out/noema-promo.mp4`. It exists so the film can
be argued with: every shot has a reason, every claim maps to a feature that
actually works, and the timing is written down rather than felt.

- **Runtime** 3,502 frames @ 30 fps = **1 min 57 s**, 1920×1080.
- **Deliverables** `out/noema-promo.mp4` (with music) and
  `out/noema-promo-nobgm.mp4` (the same cut without the music bed — the sound
  effects stay, so it still cuts; for a venue or a re-score).
- **Source of truth** `src/noema/Main.tsx` — `ORDER` is the edit, `SFX` is the
  sound, `CHAPTERS` is the copy, `ENTRY_MOVE` is the transition each shot enters
  on.
- **Second cut.** The first version ran 4,306 frames (2:23) and was rejected on
  three counts: nearly every shot was the same slow push-in, so the edit read as
  one long zoom; it was slow; and the music was the wrong twenty seconds of the
  wrong track. What changed is in §1 (motion), §3 (timing) and §6 (sound).

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
| Duration | ~2 min. The first cut landed at 2:23; the second at 1:57. Perceived pace comes from the number of events per second — cuts, transitions, landings — not from getting shorter, so the retiming took a fifth off every shot *and* gave the shots it kept more motion |
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

- `--ease-smooth: cubic-bezier(0.2, 0, 0, 1)` — every element that enters, every
  transition, every camera move that has to feel *mechanical*.
- `--ease-spring: cubic-bezier(0.34, 1.32, 0.64, 1)` — the settle at the end of
  an arrival: a ticket card landing on a board, the wordmark pressing in.
- A third curve exists for the camera alone (`cubic-bezier(0.33, 0, 0.15, 1)`),
  slower out of the gate, because a push-in that starts at full speed reads as a
  zoom rather than weight.

**Camera.** The camera is now rationed, because the first cut gave twenty of its
thirty shots the same move and the result was one continuous push-in instead of
thirty beats. There are exactly three moves, and the rest of the film is locked
off:

| Move | What it is | Used on |
| --- | --- | --- |
| `still` | locked off | 21 shots — the default |
| `snap` | a push that is over in half a second, then holds | `quickfind`, `properties` |
| `drift` | a pan at constant zoom, for a surface wider than the frame | `editor`, `ticketsList`, `project`, `roadmap` |

Three of those pans go down the page rather than across it, for a reason worth
writing down: the sidebar is exactly 240px wide, and a frame whose left edge
lands *inside* it slices every label in it mid-word. `cam()` therefore takes a
`chrome` flag that pushes the frame past the sidebar, and it is on for locked-off
shots and snaps where a static slice would read as a mistake. The one shot that
keeps the sidebar in frame (`editor`) starts at the page's own left edge, where
the sidebar is whole.

**Transitions.** Eight entry moves, built from the app's canvas colour and its
accent: five horizontal `blinds`, five vertical `columns`, four directional edge
wipes with a travelling accent line, a circular `iris`, a shadowed `slideR` /
`slideL`, a `settle` that scales down from 1.06, and a `press` that snaps up from
0.975. One table in `Main.tsx` (`ENTRY_MOVE`) says which shot gets which, and no
two neighbouring shots enter the same way. A wipe is 9–16 frames: long enough to
read as designed, short enough not to be a dissolve.

**Landings.** Where the shot's subject arrives, it arrives in its real slot —
`Land` reads the destination from the capture's `layout.json` and lifts the
element into it. The board is the full version: 34 cards on an accelerating
stagger, each with its own slot.

The board also carries the second cut's most instructive bug. The first version
flew the same 34 cards in over a texture that *already had them on it* — the
columns were photographed full, so every landing happened underneath an identical
picture and the shot's only animation was invisible. The fix is a cover plate: a
rectangle in the column's own colour (`#f7f7f5`, sampled from the texture) blanks
each slot until its card lands, so the board genuinely starts empty.

**Captions.** Wiped on, not faded. A caption is legible nine frames in, so the
reveal takes twelve frames instead of the first cut's twenty-two, with the words
lifting a few pixels behind the wipe. Twenty-two frames of opacity is most of
what made the first cut feel slow.

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
| 7 | Typed properties: relations, rollups, computed columns | `properties` | `row-embed` |
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

`from` is the absolute frame. Everything in this table is derived from `ORDER` and
`ENTRY_MOVE` in `src/noema/Main.tsx`; the shot lengths are the only numbers in the
document that matter to anything else, because every sound cue and every camera
key is written relative to them.

| Shot | from | dur | Content | Camera | Caption | Enter |
| --- | --- | --- | --- | --- | --- | --- |
| `hook` | 0 | 78 | board → burndown → chat | three 26f beats, each drifting sideways | — | columns → edge → blinds |
| `brand` | 78 | 150 | the mark and the one-line pitch | static, hold ≥1s | — | blinds |
| `cardWrite` | 228 | 72 | chapter 01 | static, hold ≥1s | — | title card |
| `editor` | 300 | 210 | the handbook: callout, toggles, code, tables | 1.24, pan down the page | The block editor — headings, callouts, toggles, code, tables | edgeR |
| `slash` | 510 | 102 | the `/` menu, filtered, one block chosen | still 1.38 | Type / for any block | columns |
| `quickfind` | 612 | 108 | ⌘P, the palette, a jump | snap 1.18 → 1.32 | Ctrl / ⌘ P — jump to any page | edgeU |
| `cardStructure` | 720 | 72 | chapter 02 | static, hold ≥1s | — | title card |
| `views` | 792 | 280 | table → board → timeline → calendar → gallery → chart → list | seven 40f beats, each locked off | a per-beat caption naming the view | one move per beat |
| `properties` | 1072 | 108 | the properties panel and its menus | snap 1.18 → 1.34 | Typed properties — relations, rollups and computed columns | edgeR |
| `rules` | 1180 | 108 | a real rule authored, then the rows it tints | 1.36 → 1.8 onto the tinted rows | Conditional formatting — rules colour the rows | edgeD |
| `peek` | 1288 | 102 | a row opened over the table | still 1.24 | Open any row without leaving the table | slideR |
| `cardShip` | 1390 | 72 | chapter 03 | static, hold ≥1s | — | title card |
| `ticketsList` | 1462 | 108 | the tracker's list: keys, labels, estimates, views | 1.2, pan right | Tickets — keys, labels, estimates, saved views | columns |
| `board` | 1570 | 156 | 34 real cards dealt into empty columns | still 1.18 — the deal is the motion | Board — every ticket, in its column | press |
| `drawer` | 1726 | 126 | the drawer: labels, relations, sub-tickets, activity | still 1.26 | The drawer — sub-tickets, relations, activity | slideL |
| `cycles` | 1852 | 150 | commitment, burndown, velocity | still 1.24, with two readouts | Cycles — commitment, burndown and velocity | iris |
| `projects` | 2002 | 120 | progress, owners, target dates | still 1.22, with two readouts | Projects — progress, owners and target dates | edgeR |
| `project` | 2122 | 108 | the timeline, and the milestone legend | 1.3, pan down to the overview | Milestones on the timeline — planned, in progress, done | edgeU |
| `roadmap` | 2230 | 108 | the workspace Gantt, project by project | 1.28, pan down | The workspace roadmap | columns |
| `cardTogether` | 2338 | 72 | chapter 04 | static, hold ≥1s | — | title card |
| `chat` | 2410 | 132 | a question, an answer drawn from the pages | still 1.22 | Ask your workspace — it answers from your own pages | slideR |
| `comments` | 2542 | 90 | comment anchored to a selection | still 1.22 | Comment on the text itself | columns |
| `versions` | 2632 | 90 | history, and a restore | still 1.18 | Every save, restorable | edgeD |
| `share` | 2722 | 96 | link, roles, publish | still 1.18 | Share with a link — or one member at a time | settle |
| `public` | 2818 | 84 | the page a visitor gets | still 1.12 | What a visitor sees | edgeL |
| `cardOwn` | 2902 | 72 | chapter 05 | static, hold ≥1s | — | title card |
| `settings` | 2974 | 96 | members, roles, invites | still 1.2 | Members, roles and invites | edgeR |
| `dark` | 3070 | 90 | the same workspace, dark | still 1.18 | The same workspace, dark | blinds |
| `desktop` | 3160 | 102 | the installer, over a dimmed settings page | static, terminal typed in | One installer. Nothing else to install. | slideR |
| `outro` | 3262 | 240 | every surface's element assembles around the mark | static, hold ≥1s | (the lockup) | — |

**Energy arc.** Low for the first 78 frames (three flashes over a bed that is
still building), then the mark holds. The chapters get progressively denser as the
edit goes: every shot after `cardStructure` carries a transition *and* a camera
move or a landing, so the events-per-second rate climbs without the shots getting
shorter than they need to be. The board at 1,570–1,726 is the loudest visual beat
— 34 landings in 1.4 s — and the last 240 frames are the peak: a launch photo,
not a fade. Both ends hold a full second after the last element moves (rule R1),
and so does every chapter card.

---

## 4 — Assets

No texture is hand-made. `video/scripts/capture.mjs` drives the installed Edge
against the seeded app and writes, per surface, a **2× PNG** and a `layout.json`
holding the page box and the box of every element a shot animates separately.

43 surfaces are captured; the film uses 29 of them, plus the elements a shot
animates on its own — the sidebar, a peek drawer, a cycle card, a project card,
and the board's 34 cards. The 2× capture is the reason a push-in stays sharp: at
1×, a camera move resolves against pixels that were only ever meant for a still.

Captures are pinned, not ambient. The app remembers the selected view and the
tracker's tab, so a shot that wants a board has to ask for a board; `capture.mjs`
sets both before it photographs anything, and the `views` shot walks all seven of
its surfaces through the same harness.

## 5 — Build

Six scene engines, not thirty bespoke shots: `PageShot` (a real page under the
2.5D camera), `HookCut`, `BrandOpen`, `BoardDeal`, `Readout`, `Outro`, plus the
`TitleCard` breath and two small overlays (`Claim`, `Terminal`). Three more pieces
carry the motion the second cut added:

- `lib/motion.tsx` — `Transition` (the eight entry moves), `Land` (an element
  lifted into a slot it reads from the capture), and `Rail` (the `03/07` progress
  strip over the `views` montage).
- `ENTRY_MOVE` in `Main.tsx` — the one table that says which shot enters on which
  move. It is a table rather than a prop on each shot so that "no two neighbouring
  shots enter the same way" is something you can check by reading it.
- `cam()`'s `chrome` flag — the 240px sidebar rule, described in §1.

`PageCam` is adapted from video-shotcraft and keeps its most valuable detail —
magnification is the CSS `zoom` property, not `scale()` in the transform chain,
because `scale()` makes Chromium rasterise at layout size and GPU-upscale, which
is what makes most screenshot push-ins look soft.

**On stale renders.** Remotion caches the webpack bundle under
`node_modules/.cache/webpack/`. A still rendered against a cache from an earlier
draft looks like the current film and is not — which is exactly how one round of
review ended up arguing with captions that no version of the source contained. If
a render disagrees with the source, delete that directory before believing it.

## 6 — Sound

**The bed is one track, cut to the edit.** The first version used a single
twenty-second window of `bgm-tech-house` and looped it. The measurement that
condemned it: the film's visual peak was the board at 1,882 (1:02.7) and the
musical peak the loop happened to contain was a breakdown. The picture and the
music were telling different stories, which is the one thing a promo cannot do.

The fix is a four-segment bed, each segment taken from the point in the track
whose own shape matches the act it plays under:

| Film | Track | Act |
| --- | --- | --- |
| 0:00 – 0:16 | 0:00 | the cold open — the track's own build |
| 0:16 – 1:04 | 0:16 | the drop, under the write and structure chapters |
| 1:04 – 1:42 | 2:34 | the climax, under ship and together |
| 1:42 – 1:56.7 | 3:20 | the outro |

Each join is an equal-power crossfade over 14 frames (0.47 s): gains follow
`sin`/`cos` rather than a straight line, because two linear ramps sum to a −3 dB
suck-out in the middle of every splice. Levels were checked, not assumed —
per-second RMS of the source measured with `ffmpeg volumedetect`, at the four
join points, reads −18.5, −18.9, −18.5 and −18.5 dB mean, so the joins do not
step. Segment gains run 0.31–0.36.

**A hand-built sidechain.** Every cue at volume ≥ 0.4 ducks the bed to 62 % on a
±20-frame triangle. It is a dozen lines of arithmetic rather than a compressor
because both the bed and the cues are fixed tables: there is nothing to react to
at render time.

**The cues.** 75 cues drawn from 30 files, all pinned to frames in a declarative
table. The rules the design follows:

- Cuts get air (whooshes), arrivals get an impact or a pop, panels get a tap.
- Cues land *on* the cuts, because the cut is the event — the hook's three beats
  share the same three cue frames as the montages that follow it.
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

**The mix, measured.** `ebur128` on the finished file: **−18.0 LUFS** integrated,
2.9 LU range, true peak −2.2 dBFS. The music-free cut measures −24.3 LUFS, which
is the quickest way to confirm the `bgm` prop is doing something.

## 7 — Review

Checked against the skill's rulebook before release:

| Rule | Result |
| --- | --- |
| R1 hold ≥1s after key information | The mark (both ends) and all five chapter cards hold a full second. The cards are 72 frames and their fade window is anchored to the *end of the shot* rather than to a fixed frame number — hard-coding it cut the card off mid-fade and left the title holding 0.8s |
| R2 acceleration, not constant speed; a rest after the run | The board accelerates its stagger and rests 0.5s once full |
| Q1 real screenshots only | Every frame is a capture; no redrawn UI |
| Q2 rasterise for 3D, CSS `zoom` not `scale()` | `PageCam` uses `zoom` for both the flat and the 3D path |
| Q9 land in real slots | Fly-ins read their destination from the capture's `layout.json` |
| Q11 captions ≥56px, auxiliary ≥32px | 58px captions, and 34px for everything else the viewer must read — auxiliary lines, readout labels, terminal output, the chapter kicker |
| S1 no game-SFX timbres | Cinematic/UI vocabulary only |
| S2 cues pinned in a table | `SFX` in `Main.tsx` |
| P4 one technique as protagonist, once | The camera is the technique, and it is now rationed: three moves across thirty shots instead of one move across twenty. The transitions took over the variety — eight entry moves, which `ENTRY_MOVE` keeps from repeating back to back |
| — no over-claim | An independent review read every caption against its own frame. It caught three the picture did not support and all three were fixed: `chat` promised citations while the panel said "No sources"; `properties` named formulas and rollups while the frame showed the column-visibility popover; `board` promised a drag the shot never performs. It also caught `ticketsList` photographing the board (a persisted view preference the capture had not pinned), which is now the List view. The `rules` shot authors a real rule rather than photographing an empty panel |
| — the shot must show what it claims | Reviewing the render, not the source, caught three more. `project` promised milestones planned → done while the frame's list renders empty, so the shot now pans to the timeline the app actually draws and quotes its own legend. The board's deal was invisible under a texture that already contained the cards — fixed with a cover plate, above. And four shots sliced the app's sidebar mid-word on the frame edge, which is what `cam()`'s `chrome` flag exists to prevent |
| — the deliverable is the render, not the source | The captions that review argued with existed in no version of the source. Remotion had served a webpack bundle cached from an earlier draft. Anything that disagrees with the working tree gets re-rendered against a cleared cache before it is believed |
