/**
 * The captured textures, typed.
 *
 * `video/scripts/capture.mjs` writes one `<name>.png` (2x) plus one
 * `<name>.layout.json` per surface. The layout is imported statically rather
 * than fetched so a shot's coordinates are available synchronously and a missing
 * capture fails the bundle instead of rendering an empty frame at 3am.
 *
 * Regenerate with:
 *   npm start -- --port 3200          # a seeded workspace (see docs/DESKTOP.md)
 *   node video/scripts/capture.mjs
 */
import landing from "../public/textures/landing.layout.json";
import login from "../public/textures/login.layout.json";
import home from "../public/textures/home.layout.json";
import homeDark from "../public/textures/home-dark.layout.json";
import editor from "../public/textures/editor.layout.json";
import slash from "../public/textures/slash.layout.json";
import quickfind from "../public/textures/quickfind.layout.json";
import palette from "../public/textures/palette.layout.json";
import dbTable from "../public/textures/db-table.layout.json";
import dbBoard from "../public/textures/db-board.layout.json";
import dbTimeline from "../public/textures/db-timeline.layout.json";
import dbChart from "../public/textures/db-chart.layout.json";
import dbList from "../public/textures/db-list.layout.json";
import dbCalendar from "../public/textures/db-calendar.layout.json";
import dbGallery from "../public/textures/db-gallery.layout.json";
import dbProperties from "../public/textures/db-properties.layout.json";
import dbRules from "../public/textures/db-rules.layout.json";
import peek from "../public/textures/peek.layout.json";
import ticketsList from "../public/textures/tickets-list.layout.json";
import ticketsBoard from "../public/textures/tickets-board.layout.json";
import ticketsTimeline from "../public/textures/tickets-timeline.layout.json";
import ticketDrawer from "../public/textures/ticket-drawer.layout.json";
import cycles from "../public/textures/cycles.layout.json";
import projects from "../public/textures/projects.layout.json";
import projectDetail from "../public/textures/project-detail.layout.json";
import roadmap from "../public/textures/roadmap.layout.json";
import library from "../public/textures/library.layout.json";
import search from "../public/textures/search.layout.json";
import inbox from "../public/textures/inbox.layout.json";
import chat from "../public/textures/chat.layout.json";
import comments from "../public/textures/comments.layout.json";
import versions from "../public/textures/versions.layout.json";
import share from "../public/textures/share.layout.json";
import publicPage from "../public/textures/public.layout.json";
import templates from "../public/textures/templates.layout.json";
import audit from "../public/textures/audit.layout.json";
import trash from "../public/textures/trash.layout.json";
import settings from "../public/textures/settings.layout.json";
import settingsData from "../public/textures/settings-data.layout.json";
import settingsTokens from "../public/textures/settings-tokens.layout.json";
import about from "../public/textures/about.layout.json";
import shortcuts from "../public/textures/shortcuts.layout.json";
import mobile from "../public/textures/mobile.layout.json";

/** An element inside a texture, in **texture space** (CSS px from its top-left). */
export type LayoutElement = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Path under `public/`, for `staticFile()`. */
  file: string;
};

export type Layout = {
  name: string;
  url: string;
  theme: string;
  fullPage: boolean;
  scale: number;
  viewport: { width: number; height: number };
  texture: { file: string; width: number; height: number };
  page: { width: number; height: number };
  scroll: { x: number; y: number };
  elements: Record<string, LayoutElement>;
};

export const LAYOUTS = {
  landing,
  login,
  home,
  "home-dark": homeDark,
  editor,
  slash,
  quickfind,
  palette,
  "db-table": dbTable,
  "db-board": dbBoard,
  "db-timeline": dbTimeline,
  "db-chart": dbChart,
  "db-list": dbList,
  "db-calendar": dbCalendar,
  "db-gallery": dbGallery,
  "db-properties": dbProperties,
  "db-rules": dbRules,
  peek,
  "tickets-list": ticketsList,
  "tickets-board": ticketsBoard,
  "tickets-timeline": ticketsTimeline,
  "ticket-drawer": ticketDrawer,
  cycles,
  projects,
  "project-detail": projectDetail,
  roadmap,
  library,
  search,
  inbox,
  chat,
  comments,
  versions,
  share,
  public: publicPage,
  templates,
  audit,
  trash,
  settings,
  "settings-data": settingsData,
  "settings-tokens": settingsTokens,
  about,
  shortcuts,
  mobile,
} as unknown as Record<string, Layout>;

/** A layout, or a loud failure naming the command that produces it. */
export function layout(name: string): Layout {
  const found = LAYOUTS[name];
  if (!found) {
    throw new Error(`No captured texture named "${name}". Run: node video/scripts/capture.mjs`);
  }
  return found;
}

/**
 * The texture's CSS height. A viewport capture is 1080 tall however long the
 * document is (the app scrolls inside the shell, not the body), and a full-page
 * capture is the document. Both are the 2x PNG height halved.
 */
export function textureH(name: string): number {
  const found = layout(name);
  return found.texture.height / found.scale;
}
