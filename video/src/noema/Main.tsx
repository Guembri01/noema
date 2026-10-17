import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { CamKey } from "../lib/PageCam";
import { NOEMA } from "../lib/theme";
import { TitleCard } from "../lib/ui";
import { Rail, type TransitionName } from "../lib/motion";
import { layout } from "../textures";
import { BoardDeal, BrandOpen, Claim, HookCut, Outro, PageShot, Readout, Terminal } from "./shots";

/* -------------------------------------------------------------------------- *
 * Camera keys, derived from the capture
 * -------------------------------------------------------------------------- *
 * A key is a fraction of the page (`fx`, `fy`) plus a zoom, and the clamping is
 * the point: a hand-typed centre is one typo away from panning off the edge of a
 * 1920x1080 viewport capture and showing the background mid-shot. Expressed as a
 * fraction of the real page box, a key cannot leave the image.
 */
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The app's sidebar is exactly 240px wide — the `home` layout measures it — and
 * the rule about it is all-or-nothing. A frame whose left edge lands *inside*
 * the sidebar slices every label in it mid-word, which reads as a mistake; a
 * frame that starts at the page edge shows it whole. `chrome` (on for locked-off
 * shots and snaps) pushes the frame past the sidebar so nothing is sliced; a
 * pan is allowed to cross it, because the sidebar is moving while it does.
 */
const CHROME = 240;

export function cam(texture: string, zoom: number, fx: number, fy: number, frame = 0, chrome = false): CamKey {
  const captured = layout(texture);
  const width = captured.viewport.width;
  const height = captured.fullPage ? captured.page.height : captured.viewport.height;
  const halfW = 960 / zoom;
  const halfH = 540 / zoom;
  const minX = chrome ? CHROME + halfW : halfW;
  return {
    frame,
    cx: clamp(fx * width, minX, Math.max(minX, width - halfW)),
    cy: clamp(fy * height, halfH, Math.max(halfH, height - halfH)),
    zoom,
  };
}

/* -------------------------------------------------------------------------- *
 * The four moves the camera is allowed to make
 * -------------------------------------------------------------------------- *
 * The first cut gave almost every shot the same slow push-in, which is why it
 * read as one long zoom rather than as thirty beats. The camera is now reserved
 * for the shots where movement carries meaning, and there are exactly three
 * moves:
 *
 *   · `still` — locked off. The default, and the answer to "why so many zooms".
 *   · `snap`  — a push that is over in a beat, then holds. A punctuation mark,
 *               used where something *arrives* rather than as decoration.
 *   · `drift` — a pan at constant zoom, for a surface wider than the frame.
 *               Movement without magnification.
 */
const still = (texture: string, zoom: number, fx: number, fy: number, chrome = true): CamKey[] => [
  cam(texture, zoom, fx, fy, 0, chrome),
];

const snap = (
  texture: string,
  from: number,
  to: number,
  fx: number,
  fy: number,
  holdAt = 16,
  chrome = true,
): CamKey[] => [
  cam(texture, from, fx, fy, 0, chrome),
  cam(texture, to, fx, fy, holdAt, chrome),
  cam(texture, to, fx, fy, holdAt + 1, chrome),
];

const drift = (
  texture: string,
  zoom: number,
  from: [number, number],
  to: [number, number],
  dur: number,
  chrome = false,
): CamKey[] => [
  cam(texture, zoom, from[0], from[1], 0, chrome),
  cam(texture, zoom, to[0], to[1], dur, chrome),
];

/* -------------------------------------------------------------------------- *
 * The timeline
 * -------------------------------------------------------------------------- *
 * One hundred and forty-four seconds was the first cut; this is 116.7. Every
 * shot lost between a fifth and a third of its length, the chapter cards went
 * from 84 frames to 72, and the captions now resolve in twelve frames instead of
 * twenty-two. Perceived speed comes from the density of *events* — cuts,
 * transitions, landings — not from being short, which is why the shots that kept
 * their length are the ones that gained motion.
 */
type Shot = { id: string; dur: number };

/**
 * A chapter card is 72 frames (2.4s): twelve for the strips to snap down, then
 * the title and the rule, then a hold. The first cut's cards were 84 and spent
 * four of those extra frames fading out, so the pause R1 asks for was never
 * really there.
 */
const CARD = 72;

export const ORDER: Shot[] = [
  { id: "hook", dur: 78 },
  { id: "brand", dur: 150 },
  { id: "cardWrite", dur: CARD },
  { id: "editor", dur: 210 },
  { id: "slash", dur: 102 },
  { id: "quickfind", dur: 108 },
  { id: "cardStructure", dur: CARD },
  { id: "views", dur: 280 },
  { id: "properties", dur: 108 },
  { id: "rules", dur: 108 },
  { id: "peek", dur: 102 },
  { id: "cardShip", dur: CARD },
  { id: "ticketsList", dur: 108 },
  { id: "board", dur: 156 },
  { id: "drawer", dur: 126 },
  { id: "cycles", dur: 150 },
  { id: "projects", dur: 120 },
  { id: "project", dur: 108 },
  { id: "roadmap", dur: 108 },
  { id: "cardTogether", dur: CARD },
  { id: "chat", dur: 132 },
  { id: "comments", dur: 90 },
  { id: "versions", dur: 90 },
  { id: "share", dur: 96 },
  { id: "public", dur: 84 },
  { id: "cardOwn", dur: CARD },
  { id: "settings", dur: 96 },
  { id: "dark", dur: 90 },
  { id: "desktop", dur: 102 },
  { id: "outro", dur: 240 },
];

export const FROM: Record<string, number> = {};
{
  let cursor = 0;
  for (const shot of ORDER) {
    FROM[shot.id] = cursor;
    cursor += shot.dur;
  }
}

/** Absolute frame of a shot (plus an offset), for pinning sound to picture. */
export const at = (id: string, offset = 0) => FROM[id] + offset;

export const FILM_TOTAL = ORDER.reduce((total, shot) => total + shot.dur, 0);

/* -------------------------------------------------------------------------- *
 * Copy
 * -------------------------------------------------------------------------- */

export const CHAPTERS = {
  cardWrite: { index: "01 — Write", title: "Write anything.", subtitle: "Notes, docs and pages that behave like paper." },
  cardStructure: {
    index: "02 — Structure",
    title: "Structure anything.",
    subtitle: "Databases with the views your work actually needs.",
  },
  cardShip: {
    index: "03 — Ship",
    title: "Ship anything.",
    subtitle: "Tickets, cycles, projects and a roadmap over the same data.",
  },
  cardTogether: {
    index: "04 — Together",
    title: "Think together.",
    subtitle: "Chat that reads your workspace. Comments on the words themselves.",
  },
  cardOwn: {
    index: "05 — Own it",
    title: "Own it.",
    subtitle: "Self-hosted, exportable, and it installs like an app.",
  },
} as const;

/* -------------------------------------------------------------------------- *
 * The entry move for every shot
 * -------------------------------------------------------------------------- *
 * One table, so the film's rhythm can be read at a glance — and so no two
 * neighbouring shots enter the same way. Eight variants across thirty beats;
 * before this every cut was a hard cut onto a push-in.
 */
const ENTRY_MOVE: Record<string, TransitionName> = {
  hook: "none", // three beats, each with its own move inside the shot
  brand: "blinds",
  cardWrite: "none",
  editor: "edgeR",
  slash: "columns",
  quickfind: "edgeU",
  cardStructure: "none",
  views: "none", // one move per view, inside the shot
  properties: "edgeR",
  rules: "edgeD",
  peek: "slideR",
  cardShip: "none",
  ticketsList: "columns",
  board: "press",
  drawer: "slideL",
  cycles: "iris",
  projects: "edgeR",
  project: "edgeU",
  roadmap: "columns",
  cardTogether: "none",
  chat: "slideR",
  comments: "columns",
  versions: "edgeD",
  share: "settle",
  public: "edgeL",
  cardOwn: "none",
  settings: "edgeR",
  dark: "blinds",
  desktop: "slideR",
  outro: "none",
};

/* -------------------------------------------------------------------------- *
 * Sound design
 * -------------------------------------------------------------------------- *
 * S2: every cue is pinned to a frame in a declarative table rather than nudged
 * in a timeline. Because every frame here is derived from `ORDER`, retiming a
 * shot moves its sound with it.
 */
type Cue = { frame: number; file: string; volume: number };

const cue = (id: string, offset: number, file: string, volume: number): Cue => ({
  frame: at(id, offset),
  file,
  volume,
});

/** The seven views of the database, one beat each. 40 frames per view. */
const VIEW_STEP = 40;
const VIEW_TRANSITIONS: TransitionName[] = ["columns", "edgeR", "blinds", "edgeU", "iris", "press", "settle"];

export const SFX: Cue[] = [
  // Cold open: three surfaces, three different entrances.
  cue("hook", 0, "whoosh-big.mp3", 0.5),
  cue("hook", 26, "wind-swoosh-short.mp3", 0.42),
  cue("hook", 52, "wind-swoosh-short.mp3", 0.42),
  // The name lands.
  cue("brand", 8, "riser-cine.mp3", 0.34),
  cue("brand", 30, "impact-deep-whoosh.mp3", 0.5),
  cue("brand", 34, "shimmer-sparkle-sweep.mp3", 0.24),
  // Writing.
  cue("cardWrite", 2, "paper-page-turn.mp3", 0.3),
  cue("editor", 6, "typewriter-hit-soft.mp3", 0.3),
  cue("editor", 34, "typewriter-hit-soft.mp3", 0.24),
  cue("editor", 62, "keyboard.mp3", 0.2),
  cue("editor", 120, "paper-slide.mp3", 0.26),
  cue("slash", 4, "ui-select-click.mp3", 0.32),
  cue("slash", 40, "ui-option-select.mp3", 0.34),
  cue("quickfind", 4, "switch-tap.mp3", 0.3),
  cue("quickfind", 44, "whoosh-fast.mp3", 0.36),
  // Structure. One snap per view, landing *on* the cut.
  cue("cardStructure", 2, "paper-page-turn.mp3", 0.3),
  cue("views", 6, "sweep-fast.mp3", 0.34),
  cue("views", 40, "transition-snap.mp3", 0.36),
  cue("views", 80, "transition-snap.mp3", 0.36),
  cue("views", 120, "transition-snap.mp3", 0.36),
  cue("views", 160, "transition-snap.mp3", 0.36),
  cue("views", 200, "transition-snap.mp3", 0.36),
  cue("views", 240, "transition-snap.mp3", 0.36),
  cue("properties", 4, "ui-select-click.mp3", 0.32),
  cue("properties", 40, "ui-confirm-tone.mp3", 0.26),
  cue("rules", 4, "switch-tap.mp3", 0.3),
  // The rule lands, then a second hit as the camera arrives on the tinted rows.
  cue("rules", 46, "ui-confirm-tone.mp3", 0.3),
  cue("rules", 74, "shimmer-sparkle-sweep.mp3", 0.2),
  cue("peek", 6, "whoosh-fast.mp3", 0.34),
  cue("peek", 40, "ui-popup-dry.mp3", 0.28),
  // Ship.
  cue("cardShip", 2, "paper-page-turn.mp3", 0.3),
  cue("ticketsList", 6, "whoosh-fast.mp3", 0.32),
  cue("ticketsList", 70, "sweep-fast.mp3", 0.3),
  cue("board", 4, "whoosh-big.mp3", 0.44),
  cue("board", 12, "impact-transition.mp3", 0.36),
  cue("board", 18, "pop.mp3", 0.3),
  cue("board", 24, "pop.mp3", 0.26),
  cue("board", 30, "pop.mp3", 0.24),
  cue("board", 36, "pop.mp3", 0.22),
  cue("drawer", 6, "whoosh-fast.mp3", 0.34),
  cue("drawer", 44, "ui-select-click.mp3", 0.3),
  cue("drawer", 96, "ui-message-pop.mp3", 0.26),
  cue("cycles", 6, "data-scan.mp3", 0.32),
  cue("cycles", 60, "clock-tick-single.mp3", 0.24),
  cue("cycles", 96, "ui-confirm-tone.mp3", 0.3),
  cue("projects", 6, "sweep-digital.mp3", 0.3),
  cue("projects", 50, "ui-confirm-tone.mp3", 0.28),
  cue("project", 6, "paper-slide.mp3", 0.28),
  cue("project", 60, "ui-notify-tech.mp3", 0.26),
  cue("roadmap", 6, "air-whoosh-powerful.mp3", 0.4),
  cue("roadmap", 70, "sweep-fast.mp3", 0.28),
  // Together.
  cue("cardTogether", 2, "paper-page-turn.mp3", 0.3),
  cue("chat", 6, "ui-select-click.mp3", 0.3),
  cue("chat", 40, "keyboard.mp3", 0.22),
  cue("chat", 96, "ui-message-pop.mp3", 0.3),
  cue("chat", 122, "shimmer-sparkle-sweep.mp3", 0.22),
  cue("comments", 6, "switch-tap.mp3", 0.3),
  cue("comments", 44, "ui-message-pop.mp3", 0.28),
  cue("versions", 6, "clock-tick-single.mp3", 0.26),
  cue("versions", 50, "ui-confirm-tone.mp3", 0.28),
  cue("share", 6, "ui-select-click.mp3", 0.3),
  cue("share", 56, "light-sweep-magic.mp3", 0.24),
  cue("public", 6, "whoosh-fast.mp3", 0.32),
  // Own it.
  cue("cardOwn", 2, "paper-page-turn.mp3", 0.3),
  cue("settings", 6, "sweep-fast.mp3", 0.3),
  cue("settings", 60, "ui-select-click.mp3", 0.28),
  cue("dark", 6, "transition-tech.mp3", 0.34),
  cue("dark", 44, "light-sweep-magic.mp3", 0.24),
  cue("desktop", 8, "machine-activate-short.mp3", 0.34),
  cue("desktop", 44, "ui-confirm-tone.mp3", 0.3),
  cue("desktop", 96, "impact-cine-big.mp3", 0.4),
  // The close.
  cue("outro", 4, "riser-cine.mp3", 0.34),
  cue("outro", 26, "impact-cine-big.mp3", 0.5),
  cue("outro", 34, "sparkle.mp3", 0.24),
  cue("outro", 150, "sweep-digital.mp3", 0.22),
];

/* -------------------------------------------------------------------------- *
 * The music bed
 * -------------------------------------------------------------------------- *
 * The first cut laid `bgm-tech-house.mp3` over the film from its first frame and
 * let it run, which meant the picture and the music told opposite stories: the
 * track's drop lands at 0:16 and its *climax* at 2:44–3:20, while the film ended
 * at 2:23 — so the visual peak (the board, at 1:02) played over the track's
 * breakdown and the film's finale played over its quiet middle. The loudest
 * twenty seconds of the track were never used at all.
 *
 * So the bed is now cut, not laid. Three segments of the same track, each
 * measured (a per-second RMS map — `video/README.md` has the method) and placed
 * so its own shape matches the act it plays under:
 *
 *   0:00–1:04  build + drop  → the cold open, the wordmark, write, structure
 *   2:34–3:12  the climax    → ship and together, the board included
 *   3:20–end   the outro     → own it, the installer and the close
 *
 * The first two segments of the four-segment version were contiguous in the
 * source, which made their join a crossfade of a signal with *itself*: the two
 * copies sum coherently, so equal-power ramps produce a +3 dB swell across the
 * splice rather than a flat join. Playing 0:00–1:04 as one segment removes the
 * join and the artefact with it, and the drop still lands on frame 480 because
 * the source is continuous there.
 *
 * The remaining two joins are between different sections, where equal-power is
 * the correct law — the two halves are uncorrelated, and two linear ramps would
 * sum to a −3 dB suck-out in the middle.
 */
type BedSegment = { at: number; from: number; dur: number; gain: number };

const XFADE = 14;

const BED: BedSegment[] = [
  // 0:00 → 1:04, the build and the drop, continuous in the source: the drop
  // still lands on frame 480, which is where the editor shot cuts in.
  { at: 0, from: 0, dur: 1920, gain: 0.34 },
  { at: 1920, from: 4620, dur: 1140, gain: 0.33 }, // 2:34 → 3:12, the climax
  { at: 3060, from: 6000, dur: FILM_TOTAL - 3060, gain: 0.31 }, // 3:20 →, the outro
];

/** Cues loud enough to be worth ducking the music under. */
const LOUD = SFX.filter((entry) => entry.volume >= 0.4);

/**
 * A triangular dip in the bed around each loud cue — a sidechain, done by hand
 * because the bed is a fixed asset and the cues are a fixed table. 20 frames
 * either side, 38% deep at the hit: enough to lift an impact off the music
 * without the bed pumping audibly.
 */
function duckAt(globalFrame: number) {
  let gain = 1;
  for (const entry of LOUD) {
    const distance = Math.abs(globalFrame - entry.frame);
    if (distance < 20) gain = Math.min(gain, 0.62 + (distance / 20) * 0.38);
  }
  return gain;
}

const MusicBed: React.FC = () => (
  <>
    {BED.map((segment, index) => {
      const lead = index === 0 ? 0 : XFADE;
      const tail = index === BED.length - 1 ? 0 : XFADE;
      const duration = segment.dur + lead + tail;
      return (
        <Sequence key={segment.from} from={segment.at - lead} durationInFrames={duration}>
          <Audio
            src={staticFile("audio/bgm.mp3")}
            startFrom={segment.from - lead}
            volume={(local) => {
              // Equal-power ramps: a linear crossfade between two loud sections
              // dips 3 dB in the middle, which is exactly where the splice is.
              const inRamp = lead > 0 ? Math.min(1, Math.max(0, local / lead)) : 1;
              const outRamp = tail > 0 ? Math.min(1, Math.max(0, (duration - local) / tail)) : 1;
              // The bed fades up from silence over the first twenty frames;
              // every later splice is handled by the equal-power ramps above.
              const fadeIn = index === 0 ? Math.min(1, local / 20) : 1;
              const fadeOut = index === BED.length - 1 ? Math.min(1, (duration - local) / 48) : 1;
              const global = segment.at - lead + local;
              return segment.gain * Math.sqrt(inRamp) * Math.sqrt(outRamp) * fadeIn * fadeOut * duckAt(global);
            }}
          />
        </Sequence>
      );
    })}
  </>
);

/* -------------------------------------------------------------------------- *
 * The shots
 * -------------------------------------------------------------------------- */

const Brand = () => (
  <BrandOpen total={150} tagline="A local-first workspace for notes, docs and databases." />
);

/**
 * Seven views of one database. Every beat is locked off and enters on a
 * *different* transition, and the rail underneath tells the viewer that this is
 * one feature being cycled rather than seven unrelated shots — the first cut had
 * all seven pushing in identically with six frames of white between them.
 */
const VIEWS: Array<{ texture: string; label: string; zoom: number; fx: number; fy: number }> = [
  { texture: "db-table", label: "Table view", zoom: 1.22, fx: 0.5, fy: 0.5 },
  { texture: "db-board", label: "Board view", zoom: 1.18, fx: 0.5, fy: 0.48 },
  { texture: "db-timeline", label: "Timeline view", zoom: 1.24, fx: 0.5, fy: 0.5 },
  { texture: "db-calendar", label: "Calendar view", zoom: 1.2, fx: 0.52, fy: 0.52 },
  { texture: "db-gallery", label: "Gallery view", zoom: 1.22, fx: 0.5, fy: 0.5 },
  { texture: "db-chart", label: "Chart view", zoom: 1.24, fx: 0.5, fy: 0.5 },
  { texture: "db-list", label: "List view", zoom: 1.2, fx: 0.5, fy: 0.52 },
];

const Views = () => {
  const frame = useCurrentFrame();
  const index = Math.min(VIEWS.length - 1, Math.floor(frame / VIEW_STEP));
  const progress = (frame - index * VIEW_STEP) / VIEW_STEP;
  return (
    <AbsoluteFill>
      {VIEWS.map((view, beat) => (
        <Sequence key={view.texture} from={beat * VIEW_STEP} durationInFrames={VIEW_STEP + 2}>
          <PageShot
            texture={view.texture}
            transition={VIEW_TRANSITIONS[beat]}
            transitionDuration={beat === 0 ? 14 : 10}
            keys={still(view.texture, view.zoom, view.fx, view.fy)}
            caption={view.label}
            captionDelay={5}
          />
        </Sequence>
      ))}
      <Rail total={VIEWS.length} index={index} progress={progress} delay={10} top={842} />
    </AbsoluteFill>
  );
};

const Cycles = () => (
  <PageShot
    texture="cycles"
    transition={ENTRY_MOVE.cycles}
    keys={still("cycles", 1.24, 0.52, 0.5)}
    caption="Cycles — commitment, burndown and velocity"
    captionDelay={26}
    overlay={
      <AbsoluteFill>
        <Readout label="Velocity" value={34} suffix="pts" x={1360} y={196} delay={44} duration={34} />
        <Readout label="Committed" value={82} suffix="%" x={1360} y={392} delay={58} duration={32} accent={NOEMA.success} />
      </AbsoluteFill>
    }
  />
);

const Projects = () => (
  <PageShot
    texture="projects"
    transition={ENTRY_MOVE.projects}
    keys={still("projects", 1.22, 0.5, 0.5)}
    caption="Projects — progress, owners and target dates"
    captionDelay={22}
    overlay={
      <AbsoluteFill>
        <Readout label="Projects" value={4} x={1360} y={196} delay={34} duration={30} />
        <Readout label="Milestones" value={6} x={1360} y={392} delay={46} duration={30} accent={NOEMA.warning} />
      </AbsoluteFill>
    }
  />
);

const Desktop = () => (
  <AbsoluteFill>
    <PageShot
      texture="settings-data"
      transition={ENTRY_MOVE.desktop}
      keys={still("settings-data", 1.28, 0.5, 0.5)}
    />
    <AbsoluteFill style={{ backgroundColor: "rgba(255,255,255,0.82)" }} />
    <Terminal
      x={510}
      y={300}
      lines={["Noema_1.4.0_x64-setup.exe", "Installed — no database to run", "Workspace restored from backup"]}
      delay={12}
    />
    <Claim text="One installer. Nothing else to install." delay={26} top={770} />
  </AbsoluteFill>
);

const OutroShot = () => {
  const board = layout("tickets-board").elements;
  const cards = Object.keys(board)
    .filter((name) => name.startsWith("card-all-"))
    .slice(0, 3);
  /** A cutout, or nothing if that capture did not produce it — a missing file
   *  must not leave a broken image in the final frame. */
  const cut = (texture: string, key: string, x: number, y: number, w: number, from: number) => {
    const found = layout(texture).elements[key];
    return found ? { file: found.file, x, y, w, from } : null;
  };
  const items = [
    cut("home", "sidebar", 96, 210, 330, -420),
    cut("peek", "drawer", 1400, 150, 430, 460),
    cut("cycles", "card", 132, 720, 470, -460),
    cut("projects", "card", 1390, 700, 420, 440),
    ...cards.map((name, index) => ({
      file: board[name].file,
      x: 700 + index * 200,
      y: 904 - index * 26,
      w: 300,
      from: index % 2 === 0 ? -300 : 300,
    })),
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  return (
    <Outro
      total={240}
      mark="Noema"
      line="Notes, docs, databases — tickets, cycles and projects."
      footer="Bilel Guembri · Wissal Ben Othmen · MIT"
      items={items}
    />
  );
};

/** Everything that is a surface plus a camera. */
function Surface({ id }: { id: string }) {
  const transition = ENTRY_MOVE[id];
  switch (id) {
    case "editor":
      return (
        <PageShot
          texture="editor"
          transition={transition}
          // A downward pan at the page's left edge: the shot is about the
          // document's range of blocks, and panning down keeps the sidebar whole
          // instead of slicing it on the way past.
          keys={drift("editor", 1.24, [0.4, 0.32], [0.4, 0.66], 210, false)}
          caption="The block editor — headings, callouts, toggles, code, tables"
          captionDelay={30}
        />
      );
    case "slash":
      return (
        <PageShot
          texture="slash"
          transition={transition}
          keys={still("slash", 1.38, 0.46, 0.62)}
          caption="Type / for any block"
          captionDelay={18}
        />
      );
    case "quickfind":
      return (
        <PageShot
          texture="quickfind"
          transition={transition}
          // A snap, then a full second of hold. The palette is the point; pushing
          // into it for four seconds would only smear the text.
          keys={snap("quickfind", 1.18, 1.32, 0.5, 0.44)}
          caption="Ctrl / ⌘ P — jump to any page"
          captionDelay={22}
        />
      );
    case "properties":
      return (
        <PageShot
          texture="db-properties"
          transition={transition}
          // A snap onto the properties panel: at this zoom the chrome rule leaves
          // only ~100px of lateral room, so the arrival is carried by the scale
          // rather than by a pan that would not move.
          keys={snap("db-properties", 1.18, 1.34, 0.62, 0.5)}
          caption="Typed properties — relations, rollups and computed columns"
          captionDelay={20}
        />
      );
    case "rules":
      return (
        <PageShot
          texture="db-rules"
          transition={transition}
          // Rule first, then effect: the frame opens on the colour-rule editor and
          // travels down onto the rows that rule has tinted. The first cut showed
          // the editor and *claimed* the rows were coloured without ever being
          // close enough to see that they were.
          keys={[
            cam("db-rules", 1.36, 0.5, 0.36, 0, true),
            cam("db-rules", 1.8, 0.7, 0.7, 46, true),
            cam("db-rules", 1.8, 0.7, 0.7, 108, true),
          ]}
          caption="Conditional formatting — rules colour the rows"
          captionDelay={56}
        />
      );
    case "peek":
      return (
        <PageShot
          texture="peek"
          transition={transition}
          keys={still("peek", 1.24, 0.6, 0.5)}
          caption="Open any row without leaving the table"
          captionDelay={20}
        />
      );
    case "ticketsList":
      return (
        <PageShot
          texture="tickets-list"
          transition={transition}
          keys={drift("tickets-list", 1.2, [0.4, 0.46], [0.64, 0.56], 108)}
          caption="Tickets — keys, labels, estimates, saved views"
          captionDelay={22}
        />
      );
    case "drawer":
      return (
        <PageShot
          texture="ticket-drawer"
          transition={transition}
          keys={still("ticket-drawer", 1.26, 0.62, 0.5)}
          caption="The drawer — sub-tickets, relations, activity"
          captionDelay={24}
        />
      );
    case "project":
      return (
        <PageShot
          texture="project-detail"
          transition={transition}
          // Down the project page from the timeline to the overview. The caption
          // claims what the timeline actually draws — the milestone legend is the
          // app's own text ("grey planned, blue in progress, green done"), not a
          // section this shot cannot reach.
          keys={drift("project-detail", 1.3, [0.56, 0.4], [0.56, 0.62], 108)}
          caption="Milestones on the timeline — planned, in progress, done"
          captionDelay={24}
        />
      );
    case "roadmap":
      return (
        <PageShot
          texture="roadmap"
          transition={transition}
          // A downward scan of the timeline: the page is longer than the frame, and
          // the shot is about how much is on it rather than about one row — a
          // locked-off frame here spent its top third on the tab bar.
          keys={drift("roadmap", 1.28, [0.44, 0.3], [0.44, 0.72], 108, true)}
          caption="The workspace roadmap"
          captionDelay={22}
        />
      );
    case "chat":
      return (
        <PageShot
          texture="chat"
          transition={transition}
          keys={still("chat", 1.22, 0.68, 0.5)}
          caption="Ask your workspace — it answers from your own pages"
          captionDelay={24}
        />
      );
    case "comments":
      return (
        <PageShot
          texture="comments"
          transition={transition}
          keys={still("comments", 1.22, 0.64, 0.5)}
          caption="Comment on the text itself"
          captionDelay={20}
        />
      );
    case "versions":
      return (
        <PageShot
          texture="versions"
          transition={transition}
          keys={still("versions", 1.18, 0.6, 0.5)}
          caption="Every save, restorable"
          captionDelay={20}
        />
      );
    case "share":
      return (
        <PageShot
          texture="share"
          transition={transition}
          keys={still("share", 1.18, 0.58, 0.5)}
          caption="Share with a link — or one member at a time"
          captionDelay={22}
        />
      );
    case "public":
      return (
        <PageShot
          texture="public"
          transition={transition}
          keys={still("public", 1.12, 0.5, 0.2, false)}
          caption="What a visitor sees"
          captionDelay={18}
          background={NOEMA.sidebar}
        />
      );
    case "settings":
      return (
        <PageShot
          texture="settings"
          transition={transition}
          keys={still("settings", 1.2, 0.6, 0.5)}
          caption="Members, roles and invites"
          captionDelay={20}
        />
      );
    case "dark":
      return (
        <PageShot
          texture="home-dark"
          transition={transition}
          keys={still("home-dark", 1.18, 0.54, 0.5)}
          caption="The same workspace, dark"
          captionDelay={18}
          background={NOEMA.dark.bg}
        />
      );
    case "home":
      return <PageShot texture="home" keys={still("home", 1.14, 0.5, 0.5)} />;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- *
 * The film
 * -------------------------------------------------------------------------- */

const renderShot = (id: string): React.ReactNode => {
  switch (id) {
    case "hook":
      return <HookCut />;
    case "brand":
      return <Brand />;
    case "cardWrite":
    case "cardStructure":
    case "cardShip":
    case "cardTogether":
    case "cardOwn":
      return <TitleCard {...CHAPTERS[id]} />;
    case "views":
      return <Views />;
    case "board":
      return (
        // Locked off, because the beat is the deal: thirty-four cards arriving on
        // an accelerating stagger, which the camera would only fight.
        <BoardDeal
          texture="tickets-board"
          keys={still("tickets-board", 1.18, 0.5, 0.46)}
          caption="Board — every ticket, in its column"
          spread={40}
        />
      );
    case "cycles":
      return <Cycles />;
    case "projects":
      return <Projects />;
    case "desktop":
      return <Desktop />;
    case "outro":
      return <OutroShot />;
    default:
      return <Surface id={id} />;
  }
};

export const NoemaFilm: React.FC<{ bgm?: boolean }> = ({ bgm = true }) => (
  <AbsoluteFill style={{ backgroundColor: NOEMA.bg }}>
    {bgm ? <MusicBed /> : null}
    {SFX.map((entry, index) => (
      <Sequence key={`${entry.file}-${index}`} from={entry.frame}>
        <Audio src={staticFile(`audio/${entry.file}`)} volume={entry.volume} />
      </Sequence>
    ))}
    {ORDER.map((shot) => (
      <Sequence key={shot.id} from={FROM[shot.id]} durationInFrames={shot.dur} name={shot.id}>
        {renderShot(shot.id)}
      </Sequence>
    ))}
  </AbsoluteFill>
);
