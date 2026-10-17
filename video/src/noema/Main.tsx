import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CamKey } from "../lib/PageCam";
import { NOEMA } from "../lib/theme";
import { Caption, Grain, TitleCard } from "../lib/ui";
import { layout, textureH } from "../textures";
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

export function cam(texture: string, zoom: number, fx: number, fy: number, frame = 0): CamKey {
  const captured = layout(texture);
  const width = captured.viewport.width;
  const height = captured.fullPage ? captured.page.height : captured.viewport.height;
  const halfW = 960 / zoom;
  const halfH = 540 / zoom;
  return {
    frame,
    cx: clamp(fx * width, halfW, Math.max(halfW, width - halfW)),
    cy: clamp(fy * height, halfH, Math.max(halfH, height - halfH)),
    zoom,
  };
}

/** A two-key move: land, then travel while the shot is on screen. */
const move = (
  texture: string,
  a: [number, number, number],
  b: [number, number, number],
  dur: number,
): CamKey[] => [cam(texture, a[0], a[1], a[2], 0), cam(texture, b[0], b[1], b[2], dur)];

/* -------------------------------------------------------------------------- *
 * The timeline
 * -------------------------------------------------------------------------- */

type Shot = { id: string; dur: number };

/**
 * Chapter cards are 84 frames (2.8s), not the 56 they started at. The title takes
 * 32 frames to arrive and R1 wants a full second of stillness after that; 56 left
 * the card with 0.8s of hold and no room for its own fade.
 */
const CARD = 84;

/**
 * Order and duration are the whole edit. Every `from` in the film — including
 * every sound cue — is derived from this list, so retiming a shot moves its
 * sound with it instead of leaving the two out of sync.
 */
export const ORDER: Shot[] = [
  { id: "hook", dur: 72 },
  { id: "brand", dur: 168 },
  { id: "cardWrite", dur: CARD },
  { id: "editor", dur: 240 },
  { id: "slash", dur: 132 },
  { id: "quickfind", dur: 138 },
  { id: "cardStructure", dur: CARD },
  { id: "views", dur: 288 },
  { id: "properties", dur: 150 },
  { id: "rules", dur: 150 },
  { id: "peek", dur: 130 },
  { id: "cardShip", dur: CARD },
  { id: "ticketsList", dur: 162 },
  { id: "board", dur: 198 },
  { id: "drawer", dur: 172 },
  { id: "cycles", dur: 192 },
  { id: "projects", dur: 150 },
  { id: "project", dur: 144 },
  { id: "roadmap", dur: 144 },
  { id: "cardTogether", dur: CARD },
  { id: "chat", dur: 176 },
  { id: "comments", dur: 126 },
  { id: "versions", dur: 120 },
  { id: "share", dur: 132 },
  { id: "public", dur: 108 },
  { id: "cardOwn", dur: CARD },
  { id: "settings", dur: 132 },
  { id: "dark", dur: 126 },
  { id: "desktop", dur: 150 },
  { id: "outro", dur: 186 },
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

/** The seven views of one database, in the order the shot cuts through them. */
const VIEW_TEXTURES = [
  "db-table",
  "db-board",
  "db-timeline",
  "db-calendar",
  "db-gallery",
  "db-chart",
  "db-list",
];

/**
 * One caption per beat. A single list caption ("table, board, timeline, …") left
 * the viewer unable to bind any name to any view — at 40 frames a view, the pill
 * has to say which view is on screen.
 */
const VIEW_LABELS = [
  "Table view",
  "Board view",
  "Timeline view",
  "Calendar view",
  "Gallery view",
  "Chart view",
  "List view",
];

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
 * Sound design
 * -------------------------------------------------------------------------- *
 * S2: every cue is pinned to a frame in a declarative table rather than nudged
 * in a timeline. `every` spreads a sample across a shot on an accelerating
 * interval so a run of identical hits does not machine-gun.
 */
type Cue = { frame: number; file: string; volume: number };

const cue = (id: string, offset: number, file: string, volume: number): Cue => ({
  frame: at(id, offset),
  file,
  volume,
});

export const SFX: Cue[] = [
  // Cold open: three surfaces, three air moves.
  cue("hook", 0, "whoosh-big.mp3", 0.5),
  cue("hook", 24, "wind-swoosh-short.mp3", 0.42),
  cue("hook", 48, "wind-swoosh-short.mp3", 0.42),
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
  // Structure.
  cue("cardStructure", 2, "paper-page-turn.mp3", 0.3),
  cue("views", 6, "sweep-fast.mp3", 0.34),
  cue("views", 46, "transition-snap.mp3", 0.36),
  cue("views", 86, "transition-snap.mp3", 0.36),
  cue("views", 126, "transition-snap.mp3", 0.36),
  cue("views", 166, "transition-snap.mp3", 0.36),
  cue("views", 206, "transition-snap.mp3", 0.36),
  cue("views", 246, "transition-snap.mp3", 0.36),
  cue("properties", 4, "ui-select-click.mp3", 0.32),
  cue("properties", 40, "ui-confirm-tone.mp3", 0.26),
  cue("rules", 4, "switch-tap.mp3", 0.3),
  cue("rules", 46, "ui-confirm-tone.mp3", 0.3),
  cue("peek", 6, "whoosh-fast.mp3", 0.34),
  cue("peek", 40, "ui-popup-dry.mp3", 0.28),
  // Ship.
  cue("cardShip", 2, "paper-page-turn.mp3", 0.3),
  cue("ticketsList", 6, "whoosh-fast.mp3", 0.32),
  cue("ticketsList", 70, "sweep-fast.mp3", 0.3),
  cue("board", 6, "whoosh-big.mp3", 0.44),
  cue("board", 20, "impact-transition.mp3", 0.36),
  cue("board", 62, "pop.mp3", 0.3),
  cue("board", 74, "pop.mp3", 0.26),
  cue("board", 84, "pop.mp3", 0.24),
  cue("board", 92, "pop.mp3", 0.22),
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
  cue("chat", 130, "shimmer-sparkle-sweep.mp3", 0.22),
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
];

/* -------------------------------------------------------------------------- *
 * The shots
 * -------------------------------------------------------------------------- */

const Brand = () => (
  <BrandOpen total={168} tagline="A local-first workspace for notes, docs and databases." />
);

const Views = () => {
  const step = 40;
  return (
    <AbsoluteFill>
      {VIEW_TEXTURES.map((texture, index) => (
        <Sequence key={texture} from={index * step} durationInFrames={step + 6}>
          <PageShot
            texture={texture}
            keys={move(texture, [1.24, 0.55, 0.52], [1.1, 0.6, 0.48], step + 6)}
          />
          <Caption delay={2} duration={10}>
            {VIEW_LABELS[index]}
          </Caption>
        </Sequence>
      ))}
      <Grain />
    </AbsoluteFill>
  );
};

const Peek = () => (
  <PageShot texture="peek" keys={move("peek", [1.06, 0.6, 0.5], [1.3, 0.72, 0.56], 130)} caption="Open any row without leaving the table" />
);

const Cycles = () => (
  <PageShot
    texture="cycles"
    keys={move("cycles", [1.16, 0.5, 0.5], [1.34, 0.44, 0.46], 192)}
    caption="Cycles — commitment, burndown and velocity"
    overlay={
      <AbsoluteFill>
        <Readout label="Velocity" value={34} suffix="pts" x={1360} y={196} delay={64} duration={52} />
        <Readout label="Committed" value={82} suffix="%" x={1360} y={392} delay={88} duration={48} accent={NOEMA.success} />
      </AbsoluteFill>
    }
  />
);

const Projects = () => (
  <PageShot
    texture="projects"
    keys={move("projects", [1.14, 0.5, 0.52], [1.3, 0.46, 0.46], 150)}
    caption="Projects — progress, owners and target dates"
    overlay={
      <AbsoluteFill>
        <Readout label="Projects" value={4} x={1360} y={196} delay={40} duration={44} />
        <Readout label="Milestones" value={6} x={1360} y={392} delay={60} duration={44} accent={NOEMA.warning} />
      </AbsoluteFill>
    }
  />
);

const Desktop = () => (
  <AbsoluteFill>
    <PageShot texture="settings-data" keys={move("settings-data", [1.2, 0.5, 0.52], [1.4, 0.46, 0.46], 150)} />
    <AbsoluteFill style={{ backgroundColor: "rgba(255,255,255,0.82)" }} />
    <Terminal
      x={510}
      y={300}
      lines={["Noema_1.4.0_x64-setup.exe", "Installed — no database to run", "Workspace restored from backup"]}
      delay={16}
    />
    <Claim text="One installer. Nothing else to install." delay={30} top={770} />
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
      total={186}
      mark="Noema"
      line="Notes, docs, databases — tickets, cycles and projects."
      footer="Bilel Guembri · Wissal Ben Othmen · MIT"
      items={items}
    />
  );
};

/** Everything that is a surface plus a camera. */
function Surface({ id }: { id: string }) {
  switch (id) {
    case "editor":
      return (
        <PageShot
          texture="editor"
          keys={move("editor", [1.3, 0.5, 0.12], [1.16, 0.52, 0.62], 240)}
          caption="The block editor — headings, callouts, toggles, code, tables"
          captionDelay={40}
        />
      );
    case "slash":
      return <PageShot texture="slash" keys={move("slash", [1.3, 0.5, 0.6], [1.5, 0.5, 0.68], 132)} caption="Type / for any block" />;
    case "quickfind":
      return (
        <PageShot texture="quickfind" keys={move("quickfind", [1.1, 0.5, 0.4], [1.22, 0.5, 0.5], 138)} caption="Ctrl / ⌘ P — jump to any page" />
      );
    case "properties":
      return (
        <PageShot
          texture="db-properties"
          keys={move("db-properties", [1.1, 0.5, 0.5], [1.3, 0.62, 0.5], 150)}
          caption="Typed properties — relations, rollups and computed columns"
        />
      );
    case "rules":
      return (
        <PageShot
          texture="db-rules"
          keys={move("db-rules", [1.12, 0.62, 0.5], [1.3, 0.72, 0.56], 150)}
          caption="Conditional formatting — rules colour the rows"
        />
      );
    case "ticketsList":
      return (
        <PageShot
          texture="tickets-list"
          keys={move("tickets-list", [1.14, 0.5, 0.42], [1.28, 0.52, 0.6], 162)}
          caption="Tickets — keys, labels, estimates, saved views"
        />
      );
    case "drawer":
      return (
        <PageShot
          texture="ticket-drawer"
          keys={move("ticket-drawer", [1.16, 0.6, 0.5], [1.34, 0.7, 0.6], 172)}
          caption="The drawer — sub-tickets, relations, activity"
        />
      );
    case "project":
      return (
        <PageShot
          texture="project-detail"
          keys={move("project-detail", [1.14, 0.5, 0.5], [1.3, 0.54, 0.62], 144)}
          caption="Milestones — planned → in progress → done"
        />
      );
    case "roadmap":
      return (
        <PageShot
          texture="roadmap"
          keys={move("roadmap", [1.18, 0.42, 0.3], [1.44, 0.46, 0.46], 144)}
          caption="The workspace roadmap"
        />
      );
    case "chat":
      return (
        <PageShot
          texture="chat"
          keys={move("chat", [1.14, 0.62, 0.5], [1.3, 0.74, 0.58], 176)}
          caption="Ask your workspace — it answers from your own pages"
        />
      );
    case "comments":
      return <PageShot texture="comments" keys={move("comments", [1.16, 0.6, 0.5], [1.32, 0.72, 0.6], 126)} caption="Comment on the text itself" />;
    case "versions":
      return <PageShot texture="versions" keys={move("versions", [1.14, 0.62, 0.5], [1.3, 0.72, 0.56], 120)} caption="Every save, restorable" />;
    case "share":
      return <PageShot texture="share" keys={move("share", [1.12, 0.55, 0.5], [1.26, 0.66, 0.52], 132)} caption="Share with a link — or one member at a time" />;
    case "public":
      return (
        <PageShot
          texture="public"
          keys={move("public", [1.1, 0.5, 0.16], [1.18, 0.5, 0.5], 108)}
          caption="What a visitor sees"
          background={NOEMA.sidebar}
        />
      );
    case "settings":
      return (
        <PageShot
          texture="settings"
          keys={move("settings", [1.14, 0.62, 0.42], [1.26, 0.66, 0.6], 132)}
          caption="Members, roles and invites"
        />
      );
    case "dark":
      return (
        <PageShot
          texture="home-dark"
          keys={move("home-dark", [1.12, 0.52, 0.5], [1.24, 0.58, 0.54], 126)}
          caption="The same workspace, dark"
          background={NOEMA.dark.bg}
        />
      );
    case "home":
      return <PageShot texture="home" keys={move("home", [1.1, 0.5, 0.5], [1.2, 0.56, 0.5], 120)} />;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- *
 * The film
 * -------------------------------------------------------------------------- */

const renderShot = (id: string, dur: number): React.ReactNode => {
  switch (id) {
    case "hook":
      return <HookCut textures={["tickets-board", "cycles", "chat"]} />;
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
    case "peek":
      return <Peek />;
    case "board":
      return (
        <BoardDeal
          texture="tickets-board"
          keys={move("tickets-board", [1.14, 0.5, 0.5], [1.24, 0.56, 0.5], dur)}
          caption="Board — every ticket, in its column"
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
    {bgm ? <Audio src={staticFile("audio/bgm.mp3")} volume={0.22} /> : null}
    {SFX.map((entry, index) => (
      <Sequence key={`${entry.file}-${index}`} from={entry.frame}>
        <Audio src={staticFile(`audio/${entry.file}`)} volume={entry.volume} />
      </Sequence>
    ))}
    {ORDER.map((shot) => (
      <Sequence key={shot.id} from={FROM[shot.id]} durationInFrames={shot.dur} name={shot.id}>
        {renderShot(shot.id, shot.dur)}
      </Sequence>
    ))}
  </AbsoluteFill>
);
