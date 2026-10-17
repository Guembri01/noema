/**
 * The demo workspace's databases: properties, views, rows and the relation
 * pairs between them.
 *
 * Kept as data (not code) so `seed.ts` stays a small engine: it creates every
 * database from these specs, then resolves relations, rollups, view configs and
 * row values. Property and view ids are placeholders — the seed mints real ids
 * and rewrites the configs that reference them (`groupByPropertyId`,
 * `relationPropertyId`, `previewPropertyId`, …).
 *
 * "Product roadmap" is the one database that predates this file: its title,
 * icon, three original properties and four original rows are preserved exactly
 * as the first seed created them, and everything else is additive.
 */

import { PHOTOS } from "./demo-pages";

export type DbOptionSpec = { id: string; name: string; color: string; group?: string };

export type DbPropertySpec = {
  name: string;
  type: string;
  primary?: boolean;
  options?: DbOptionSpec[];
  /** NUMBER: "number" | "percent" | "currency". */
  format?: string;
  currency?: string;
  /** RELATION: seed key of the database this property points at. */
  relation?: string;
  /** ROLLUP: the relation property on *this* database, its target property, and the function. */
  rollup?: { relation: string; target: string; fn: string };
  /** FORMULA: the expression source. */
  expression?: string;
};

export type DbRowSpec = {
  title: string;
  icon?: string;
  coverUrl?: string;
  /** Property name → stored value (see `PropertyValue.value` shapes). */
  values: Record<string, unknown>;
};

export type DbViewSpec = {
  name: string;
  type: "TABLE" | "BOARD" | "LIST" | "GALLERY" | "CALENDAR" | "TIMELINE" | "CHART";
  config?: Record<string, unknown>;
};

export type DbSpec = {
  key: string;
  title: string;
  icon: string;
  position: number;
  favorite?: boolean;
  properties: DbPropertySpec[];
  views: DbViewSpec[];
  rows: DbRowSpec[];
  templates?: { name: string; icon: string; isDefault?: boolean; body: string[] }[];
};

/** Two-way relations, declared once: `[db, property]` on both sides. */
export const relationPairs: [string, string, string, string][] = [
  ["tasks", "Feature", "roadmap", "Tasks"],
  ["bugs", "Related task", "tasks", "Bugs"],
  ["requests", "Customer", "crm", "Requests"],
];

/** Row-to-row links, declared on one side; the seed writes both sides. */
export const rowLinks: { from: [string, string]; property: string; to: [string, string] }[] = [
  { from: ["tasks", "Land the inline-database block"], property: "Feature", to: ["roadmap", "Inline databases"] },
  { from: ["tasks", "Chart view: axis labels"], property: "Feature", to: ["roadmap", "Chart views"] },
  { from: ["tasks", "Timeline drag snapping"], property: "Feature", to: ["roadmap", "Timeline view"] },
  { from: ["tasks", "Virtualise the sidebar"], property: "Feature", to: ["roadmap", "Virtualised editor"] },
  { from: ["tasks", "Recurring template DST bug"], property: "Feature", to: ["roadmap", "Recurring templates"] },
  { from: ["tasks", "Public API v1: read endpoints"], property: "Feature", to: ["roadmap", "Public API v1"] },
  { from: ["tasks", "Search: filter by type"], property: "Feature", to: ["roadmap", "Search filters"] },
  { from: ["tasks", "Mobile: offline draft queue"], property: "Feature", to: ["roadmap", "Mobile offline queue"] },
  { from: ["bugs", "Duplicated rows on concurrent paste"], property: "Related task", to: ["tasks", "Land the inline-database block"] },
  { from: ["bugs", "Sidebar is slow above 2,000 pages"], property: "Related task", to: ["tasks", "Virtualise the sidebar"] },
  { from: ["bugs", "Timeline bar lands off-week"], property: "Related task", to: ["tasks", "Timeline drag snapping"] },
  { from: ["requests", "Inline databases on any page"], property: "Customer", to: ["crm", "Northwind Logistics"] },
  { from: ["requests", "Inline databases on any page"], property: "Customer", to: ["crm", "Kestrel Health"] },
  { from: ["requests", "Offline mode for the desktop app"], property: "Customer", to: ["crm", "Lumen Robotics"] },
  { from: ["requests", "Audit log filters"], property: "Customer", to: ["crm", "Harbour & Co"] },
  { from: ["requests", "Better search filters"], property: "Customer", to: ["crm", "Vela Studio"] },
  { from: ["requests", "Granular page permissions"], property: "Customer", to: ["crm", "Meridian Bank"] },
];

const cover = (photoId: string) =>
  `https://images.unsplash.com/${photoId}?w=1200&q=80&auto=format&fit=crop`;

export const databaseSpecs: DbSpec[] = [
  /* -------------------------------------------------------- product roadmap */
  {
    key: "roadmap",
    title: "Product roadmap",
    icon: "🗂️",
    position: 3000,
    favorite: true,
    properties: [
      { name: "Name", type: "TEXT", primary: true },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { id: "todo", name: "To-do", color: "gray" },
          { id: "doing", name: "In progress", color: "blue" },
          { id: "done", name: "Done", color: "green" },
        ],
      },
      { name: "Owner", type: "PEOPLE" },
      {
        name: "Priority",
        type: "SELECT",
        options: [
          { id: "p0", name: "P0", color: "red" },
          { id: "p1", name: "P1", color: "orange" },
          { id: "p2", name: "P2", color: "yellow" },
        ],
      },
      { name: "Timeline", type: "DATE" },
      { name: "Due", type: "DATE" },
      { name: "Progress", type: "NUMBER", format: "percent" },
      { name: "Tasks", type: "RELATION", relation: "tasks" },
      { name: "Est. (tasks)", type: "ROLLUP", rollup: { relation: "Tasks", target: "Estimate", fn: "sum" } },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Status" } },
      { name: "Timeline", type: "TIMELINE" },
      { name: "By status", type: "CHART", config: { chartType: "donut", groupByPropertyId: "Status" } },
      { name: "List", type: "LIST" },
    ],
    rows: [
      /* The four rows the original seed created — untouched. */
      { title: "Define the data model", values: { Status: { optionId: "done" }, Owner: { names: ["Demo User"] } } },
      { title: "Build the block editor", values: { Status: { optionId: "doing" }, Owner: { names: ["Demo User"] } } },
      { title: "Add realtime collaboration", values: { Status: { optionId: "todo" }, Owner: { names: ["Demo User"] } } },
      { title: "Ship public API", values: { Status: { optionId: "todo" }, Owner: { names: ["Demo User"] } } },
      {
        title: "Inline databases",
        icon: "🧩",
        values: {
          Status: { optionId: "done" },
          Owner: { names: ["Louis Marchand"] },
          Priority: { optionId: "p0" },
          Timeline: { start: "2026-09-15", end: "2026-10-14" },
          Due: { start: "2026-10-14" },
          Progress: { number: 1 },
        },
      },
      {
        title: "Chart views",
        icon: "📊",
        values: {
          Status: { optionId: "done" },
          Owner: { names: ["Priya Raman"] },
          Priority: { optionId: "p1" },
          Timeline: { start: "2026-09-22", end: "2026-10-10" },
          Due: { start: "2026-10-10" },
          Progress: { number: 1 },
        },
      },
      {
        title: "Timeline view",
        icon: "📅",
        values: {
          Status: { optionId: "done" },
          Owner: { names: ["Priya Raman"] },
          Priority: { optionId: "p1" },
          Timeline: { start: "2026-09-08", end: "2026-09-26" },
          Due: { start: "2026-09-26" },
          Progress: { number: 1 },
        },
      },
      {
        title: "Recurring templates",
        icon: "🔁",
        values: {
          Status: { optionId: "done" },
          Owner: { names: ["Tomás Ferreira"] },
          Priority: { optionId: "p2" },
          Timeline: { start: "2026-08-18", end: "2026-09-05" },
          Due: { start: "2026-09-05" },
          Progress: { number: 1 },
        },
      },
      {
        title: "Virtualised editor",
        icon: "⚡",
        values: {
          Status: { optionId: "doing" },
          Owner: { names: ["Tomás Ferreira"] },
          Priority: { optionId: "p0" },
          Timeline: { start: "2026-10-05", end: "2026-11-14" },
          Due: { start: "2026-11-14" },
          Progress: { number: 0.4 },
        },
      },
      {
        title: "Dark theme pass",
        icon: "🌙",
        values: {
          Status: { optionId: "doing" },
          Owner: { names: ["Priya Raman"] },
          Priority: { optionId: "p2" },
          Timeline: { start: "2026-10-12", end: "2026-10-30" },
          Due: { start: "2026-10-30" },
          Progress: { number: 0.6 },
        },
      },
      {
        title: "Two-factor recovery codes",
        icon: "🔐",
        values: {
          Status: { optionId: "todo" },
          Owner: { names: ["Louis Marchand"] },
          Priority: { optionId: "p2" },
          Timeline: { start: "2026-11-02", end: "2026-11-20" },
          Due: { start: "2026-11-20" },
          Progress: { number: 0 },
        },
      },
      {
        title: "Audit log filters",
        icon: "🧾",
        values: {
          Status: { optionId: "todo" },
          Owner: { names: ["Louis Marchand"] },
          Priority: { optionId: "p2" },
          Timeline: { start: "2026-11-09", end: "2026-11-27" },
          Due: { start: "2026-11-27" },
          Progress: { number: 0 },
        },
      },
      {
        title: "Search filters",
        icon: "🔎",
        values: {
          Status: { optionId: "todo" },
          Owner: { names: ["Tomás Ferreira"] },
          Priority: { optionId: "p1" },
          Timeline: { start: "2026-11-16", end: "2026-12-04" },
          Due: { start: "2026-12-04" },
          Progress: { number: 0 },
        },
      },
      {
        title: "Public API v1",
        icon: "🔌",
        values: {
          Status: { optionId: "todo" },
          Owner: { names: ["Louis Marchand"] },
          Priority: { optionId: "p0" },
          Timeline: { start: "2026-11-30", end: "2026-12-12" },
          Due: { start: "2026-12-12" },
          Progress: { number: 0 },
        },
      },
      {
        title: "Mobile offline queue",
        icon: "📱",
        values: {
          Status: { optionId: "todo" },
          Owner: { names: ["Tomás Ferreira"] },
          Priority: { optionId: "p1" },
          Timeline: { start: "2026-12-01", end: "2026-12-19" },
          Due: { start: "2026-12-19" },
          Progress: { number: 0 },
        },
      },
    ],
  },

  /* ---------------------------------------------------------- task tracking */
  {
    key: "tasks",
    title: "Task tracking",
    icon: "✅",
    position: 4000,
    properties: [
      { name: "Name", type: "TEXT", primary: true },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { id: "backlog", name: "Backlog", color: "gray" },
          { id: "todo", name: "Todo", color: "blue" },
          { id: "doing", name: "In progress", color: "yellow" },
          { id: "review", name: "In review", color: "purple" },
          { id: "done", name: "Done", color: "green" },
        ],
      },
      {
        name: "Priority",
        type: "SELECT",
        options: [
          { id: "urgent", name: "Urgent", color: "red" },
          { id: "high", name: "High", color: "orange" },
          { id: "medium", name: "Medium", color: "yellow" },
          { id: "low", name: "Low", color: "blue" },
        ],
      },
      { name: "Assignee", type: "PEOPLE" },
      { name: "Dates", type: "DATE" },
      { name: "Estimate", type: "NUMBER" },
      { name: "Feature", type: "RELATION", relation: "roadmap" },
      { name: "Bugs", type: "RELATION", relation: "bugs" },
      {
        name: "Cycle",
        type: "SELECT",
        options: [
          { id: "s21", name: "Sprint 21", color: "gray" },
          { id: "s22", name: "Sprint 22", color: "blue" },
          { id: "s23", name: "Sprint 23", color: "purple" },
        ],
      },
      {
        name: "Labels",
        type: "MULTI_SELECT",
        options: [
          { id: "editor", name: "editor", color: "green" },
          { id: "database", name: "database", color: "purple" },
          { id: "search", name: "search", color: "blue" },
          { id: "auth", name: "auth", color: "yellow" },
          { id: "design", name: "design", color: "pink" },
          { id: "infra", name: "infra", color: "gray" },
        ],
      },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Status", laneBy: "Priority" } },
      { name: "Calendar", type: "CALENDAR" },
      { name: "List", type: "LIST" },
    ],
    rows: [
      {
        title: "Land the inline-database block",
        icon: "🧩",
        values: {
          Status: { optionId: "doing" },
          Priority: { optionId: "urgent" },
          Assignee: { names: ["Louis Marchand"] },
          Dates: { start: "2026-10-13", end: "2026-10-23" },
          Estimate: { number: 8 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["editor", "database"] },
        },
      },
      {
        title: "Chart view: axis labels",
        icon: "📊",
        values: {
          Status: { optionId: "review" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Priya Raman"] },
          Dates: { start: "2026-10-08", end: "2026-10-16" },
          Estimate: { number: 5 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["database", "design"] },
        },
      },
      {
        title: "Timeline drag snapping",
        icon: "📅",
        values: {
          Status: { optionId: "doing" },
          Priority: { optionId: "high" },
          Assignee: { names: ["Priya Raman"] },
          Dates: { start: "2026-10-12", end: "2026-10-20" },
          Estimate: { number: 5 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["database", "design"] },
        },
      },
      {
        title: "Virtualise the sidebar",
        icon: "⚡",
        values: {
          Status: { optionId: "doing" },
          Priority: { optionId: "high" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-10-05", end: "2026-10-26" },
          Estimate: { number: 8 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["editor", "infra"] },
        },
      },
      {
        title: "Recurring template DST bug",
        icon: "🔁",
        values: {
          Status: { optionId: "todo" },
          Priority: { optionId: "high" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-10-19", end: "2026-10-27" },
          Estimate: { number: 3 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["infra"] },
        },
      },
      {
        title: "Public API v1: read endpoints",
        icon: "🔌",
        values: {
          Status: { optionId: "backlog" },
          Priority: { optionId: "high" },
          Assignee: { names: ["Louis Marchand"] },
          Dates: { start: "2026-11-30", end: "2026-12-12" },
          Estimate: { number: 13 },
          Cycle: { optionId: "s23" },
          Labels: { optionIds: ["infra"] },
        },
      },
      {
        title: "Search: filter by type",
        icon: "🔎",
        values: {
          Status: { optionId: "backlog" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-11-16", end: "2026-12-04" },
          Estimate: { number: 8 },
          Cycle: { optionId: "s23" },
          Labels: { optionIds: ["search"] },
        },
      },
      {
        title: "Mobile: offline draft queue",
        icon: "📱",
        values: {
          Status: { optionId: "backlog" },
          Priority: { optionId: "low" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-12-01", end: "2026-12-19" },
          Estimate: { number: 21 },
          Labels: { optionIds: ["infra"] },
        },
      },
      {
        title: "Session key rotation",
        icon: "🔐",
        values: {
          Status: { optionId: "todo" },
          Priority: { optionId: "high" },
          Assignee: { names: ["Louis Marchand"] },
          Dates: { start: "2026-10-20", end: "2026-10-30" },
          Estimate: { number: 5 },
          Labels: { optionIds: ["auth", "infra"] },
        },
      },
      {
        title: "Board WIP limits persist",
        icon: "🚧",
        values: {
          Status: { optionId: "todo" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-10-19", end: "2026-10-23" },
          Estimate: { number: 3 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["database", "editor"] },
        },
      },
      {
        title: "Dark theme contrast pass",
        icon: "🌙",
        values: {
          Status: { optionId: "todo" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Priya Raman"] },
          Dates: { start: "2026-10-21", end: "2026-10-28" },
          Estimate: { number: 2 },
          Labels: { optionIds: ["design"] },
        },
      },
      {
        title: "Onboarding tour: five steps",
        icon: "🧭",
        values: {
          Status: { optionId: "doing" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Sofia Lindqvist"] },
          Dates: { start: "2026-10-06", end: "2026-10-22" },
          Estimate: { number: 5 },
          Labels: { optionIds: ["design"] },
        },
      },
      {
        title: "Write the v2.0 changelog",
        icon: "📝",
        values: {
          Status: { optionId: "doing" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Priya Raman"] },
          Dates: { start: "2026-10-14", end: "2026-10-19" },
          Estimate: { number: 3 },
          Cycle: { optionId: "s22" },
          Labels: { optionIds: ["design"] },
        },
      },
      {
        title: "Reduce the desktop bundle",
        icon: "📦",
        values: {
          Status: { optionId: "todo" },
          Priority: { optionId: "medium" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-10-22", end: "2026-11-06" },
          Estimate: { number: 5 },
          Labels: { optionIds: ["infra"] },
        },
      },
      {
        title: "Migrate the search index to GIN",
        icon: "🧱",
        values: {
          Status: { optionId: "done" },
          Priority: { optionId: "high" },
          Assignee: { names: ["Tomás Ferreira"] },
          Dates: { start: "2026-09-30", end: "2026-10-02" },
          Estimate: { number: 5 },
          Cycle: { optionId: "s21" },
          Labels: { optionIds: ["search", "infra"] },
        },
      },
      {
        title: "Fix the login redirect loop",
        icon: "🐛",
        values: {
          Status: { optionId: "done" },
          Priority: { optionId: "urgent" },
          Assignee: { names: ["Louis Marchand"] },
          Dates: { start: "2026-10-01", end: "2026-10-03" },
          Estimate: { number: 3 },
          Cycle: { optionId: "s21" },
          Labels: { optionIds: ["auth"] },
        },
      },
      {
        title: "Document the tickets API",
        icon: "📚",
        values: {
          Status: { optionId: "done" },
          Priority: { optionId: "low" },
          Assignee: { names: ["Priya Raman"] },
          Dates: { start: "2026-09-29", end: "2026-10-01" },
          Estimate: { number: 2 },
          Cycle: { optionId: "s21" },
          Labels: { optionIds: ["infra"] },
        },
      },
    ],
    templates: [
      {
        name: "Bug report",
        icon: "🐛",
        isDefault: false,
        body: ["What happened", "What you expected", "Steps to reproduce", "Environment"],
      },
      {
        name: "Sprint task",
        icon: "✅",
        isDefault: true,
        body: ["Context", "Definition of done", "Open questions"],
      },
    ],
  },

  /* ------------------------------------------------------------ bug tracker */
  {
    key: "bugs",
    title: "Bug tracker",
    icon: "🐞",
    position: 5000,
    properties: [
      { name: "Name", type: "TEXT", primary: true },
      {
        name: "Severity",
        type: "STATUS",
        options: [
          { id: "critical", name: "Critical", color: "red" },
          { id: "high", name: "High", color: "orange" },
          { id: "medium", name: "Medium", color: "yellow" },
          { id: "low", name: "Low", color: "gray" },
        ],
      },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { id: "new", name: "New", color: "gray" },
          { id: "triaged", name: "Triaged", color: "blue" },
          { id: "fixing", name: "Fixing", color: "yellow" },
          { id: "fixed", name: "Fixed", color: "green" },
          { id: "wontfix", name: "Won't fix", color: "red" },
        ],
      },
      {
        name: "Area",
        type: "SELECT",
        options: [
          { id: "editor", name: "Editor", color: "green" },
          { id: "database", name: "Databases", color: "purple" },
          { id: "auth", name: "Auth", color: "yellow" },
          { id: "search", name: "Search", color: "blue" },
          { id: "infra", name: "Infra", color: "gray" },
          { id: "mobile", name: "Mobile", color: "pink" },
        ],
      },
      { name: "Reporter", type: "PEOPLE" },
      { name: "Reported", type: "DATE" },
      { name: "Related task", type: "RELATION", relation: "tasks" },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Severity" } },
      { name: "List", type: "LIST" },
    ],
    rows: [
      {
        title: "Duplicated rows on concurrent paste",
        icon: "📋",
        values: {
          Severity: { optionId: "critical" },
          Status: { optionId: "fixing" },
          Area: { optionId: "database" },
          Reporter: { names: ["Priya Raman"] },
          Reported: { start: "2026-10-15" },
        },
      },
      {
        title: "Sidebar is slow above 2,000 pages",
        icon: "🐌",
        values: {
          Severity: { optionId: "high" },
          Status: { optionId: "fixing" },
          Area: { optionId: "infra" },
          Reporter: { names: ["Tomás Ferreira"] },
          Reported: { start: "2026-10-07" },
        },
      },
      {
        title: "Timeline bar lands off-week",
        icon: "📅",
        values: {
          Severity: { optionId: "high" },
          Status: { optionId: "triaged" },
          Area: { optionId: "database" },
          Reporter: { names: ["Amara Okafor"] },
          Reported: { start: "2026-10-11" },
        },
      },
      {
        title: "Recurring template fires twice after DST",
        icon: "🕰️",
        values: {
          Severity: { optionId: "high" },
          Status: { optionId: "triaged" },
          Area: { optionId: "infra" },
          Reporter: { names: ["Louis Marchand"] },
          Reported: { start: "2026-10-09" },
        },
      },
      {
        title: "Callout colours fail contrast in dark mode",
        icon: "🌙",
        values: {
          Severity: { optionId: "medium" },
          Status: { optionId: "new" },
          Area: { optionId: "editor" },
          Reporter: { names: ["Priya Raman"] },
          Reported: { start: "2026-10-13" },
        },
      },
      {
        title: "Bookmark preview missing on paywalled pages",
        icon: "🔖",
        values: {
          Severity: { optionId: "low" },
          Status: { optionId: "new" },
          Area: { optionId: "editor" },
          Reporter: { names: ["Sofia Lindqvist"] },
          Reported: { start: "2026-10-14" },
        },
      },
      {
        title: "Emoji picker drops frames on large sets",
        icon: "😀",
        values: {
          Severity: { optionId: "low" },
          Status: { optionId: "triaged" },
          Area: { optionId: "editor" },
          Reporter: { names: ["Priya Raman"] },
          Reported: { start: "2026-10-08" },
        },
      },
      {
        title: "Search misses pages written before the index",
        icon: "🔎",
        values: {
          Severity: { optionId: "medium" },
          Status: { optionId: "fixed" },
          Area: { optionId: "search" },
          Reporter: { names: ["Tomás Ferreira"] },
          Reported: { start: "2026-10-02" },
        },
      },
      {
        title: "Stale session cookie bounces between login and app",
        icon: "🔐",
        values: {
          Severity: { optionId: "critical" },
          Status: { optionId: "fixed" },
          Area: { optionId: "auth" },
          Reporter: { names: ["Louis Marchand"] },
          Reported: { start: "2026-10-01" },
        },
      },
      {
        title: "Paste loses the first character on mobile Safari",
        icon: "📱",
        values: {
          Severity: { optionId: "low" },
          Status: { optionId: "wontfix" },
          Area: { optionId: "mobile" },
          Reporter: { names: ["Tomás Ferreira"] },
          Reported: { start: "2026-09-26" },
        },
      },
    ],
  },

  /* ------------------------------------------------------------------- CRM */
  {
    key: "crm",
    title: "CRM — Customers",
    icon: "📇",
    position: 7000,
    properties: [
      { name: "Company", type: "TEXT", primary: true },
      { name: "Contact", type: "TEXT" },
      { name: "Email", type: "EMAIL" },
      {
        name: "Plan",
        type: "SELECT",
        options: [
          { id: "free", name: "Free", color: "gray" },
          { id: "team", name: "Team", color: "blue" },
          { id: "business", name: "Business", color: "purple" },
          { id: "enterprise", name: "Enterprise", color: "orange" },
        ],
      },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { id: "lead", name: "Lead", color: "gray" },
          { id: "trial", name: "Trial", color: "blue" },
          { id: "active", name: "Active", color: "green" },
          { id: "churned", name: "Churned", color: "red" },
        ],
      },
      { name: "MRR", type: "NUMBER", format: "currency", currency: "EUR" },
      { name: "ARR", type: "FORMULA", expression: 'prop("MRR") * 12' },
      { name: "Owner", type: "PEOPLE" },
      { name: "Since", type: "DATE" },
      { name: "Requests", type: "RELATION", relation: "requests" },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Status" } },
      { name: "List", type: "LIST" },
    ],
    rows: [
      {
        title: "Northwind Logistics",
        icon: "🚚",
        values: {
          Contact: { text: "Elena Fischer" },
          Email: { text: "elena.fischer@northwind.example" },
          Plan: { optionId: "enterprise" },
          Status: { optionId: "active" },
          MRR: { number: 2400 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2024-03-11" },
        },
      },
      {
        title: "Kestrel Health",
        icon: "🩺",
        values: {
          Contact: { text: "Dr. Maya Rao" },
          Email: { text: "maya.rao@kestrel.example" },
          Plan: { optionId: "business" },
          Status: { optionId: "active" },
          MRR: { number: 1150 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2024-09-02" },
        },
      },
      {
        title: "Lumen Robotics",
        icon: "🤖",
        values: {
          Contact: { text: "Jonas Weber" },
          Email: { text: "jonas@lumen.example" },
          Plan: { optionId: "business" },
          Status: { optionId: "active" },
          MRR: { number: 890 },
          Owner: { names: ["Sofia Lindqvist"] },
          Since: { start: "2025-01-20" },
        },
      },
      {
        title: "Meridian Bank",
        icon: "🏦",
        values: {
          Contact: { text: "Aisha Bello" },
          Email: { text: "aisha.bello@meridian.example" },
          Plan: { optionId: "enterprise" },
          Status: { optionId: "active" },
          MRR: { number: 3200 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2023-11-06" },
        },
      },
      {
        title: "Vela Studio",
        icon: "🎬",
        values: {
          Contact: { text: "Marco Silva" },
          Email: { text: "marco@vela.example" },
          Plan: { optionId: "team" },
          Status: { optionId: "active" },
          MRR: { number: 480 },
          Owner: { names: ["Sofia Lindqvist"] },
          Since: { start: "2025-04-14" },
        },
      },
      {
        title: "Harbour & Co",
        icon: "⚓",
        values: {
          Contact: { text: "Grace Whitfield" },
          Email: { text: "grace@harbourco.example" },
          Plan: { optionId: "team" },
          Status: { optionId: "active" },
          MRR: { number: 320 },
          Owner: { names: ["Sofia Lindqvist"] },
          Since: { start: "2025-06-30" },
        },
      },
      {
        title: "Aster Labs",
        icon: "🧪",
        values: {
          Contact: { text: "Ravi Menon" },
          Email: { text: "ravi@asterlabs.example" },
          Plan: { optionId: "team" },
          Status: { optionId: "trial" },
          MRR: { number: 0 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2026-10-01" },
        },
      },
      {
        title: "Pinewood Academy",
        icon: "🎓",
        values: {
          Contact: { text: "Hannah Berg" },
          Email: { text: "hannah.berg@pinewood.example" },
          Plan: { optionId: "business" },
          Status: { optionId: "trial" },
          MRR: { number: 0 },
          Owner: { names: ["Sofia Lindqvist"] },
          Since: { start: "2026-10-06" },
        },
      },
      {
        title: "Copperfield Media",
        icon: "📰",
        values: {
          Contact: { text: "Daniel Osei" },
          Email: { text: "daniel@copperfield.example" },
          Plan: { optionId: "team" },
          Status: { optionId: "lead" },
          MRR: { number: 0 },
          Owner: { names: ["Sofia Lindqvist"] },
          Since: { start: "2026-10-12" },
        },
      },
      {
        title: "Solstice Travel",
        icon: "✈️",
        values: {
          Contact: { text: "Nadia Karim" },
          Email: { text: "nadia@solstice.example" },
          Plan: { optionId: "team" },
          Status: { optionId: "churned" },
          MRR: { number: 0 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2024-07-19" },
        },
      },
      {
        title: "Brightwell Retail",
        icon: "🛍️",
        values: {
          Contact: { text: "Tom Becker" },
          Email: { text: "tom.becker@brightwell.example" },
          Plan: { optionId: "business" },
          Status: { optionId: "active" },
          MRR: { number: 760 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2025-09-08" },
        },
      },
      {
        title: "Foundry Works",
        icon: "🏭",
        values: {
          Contact: { text: "Ingrid Halvorsen" },
          Email: { text: "ingrid@foundryworks.example" },
          Plan: { optionId: "enterprise" },
          Status: { optionId: "active" },
          MRR: { number: 1800 },
          Owner: { names: ["Amara Okafor"] },
          Since: { start: "2024-12-01" },
        },
      },
    ],
  },

  /* ------------------------------------------------------- content calendar */
  {
    key: "content",
    title: "Content calendar",
    icon: "📚",
    position: 8000,
    properties: [
      { name: "Title", type: "TEXT", primary: true },
      {
        name: "Channel",
        type: "SELECT",
        options: [
          { id: "blog", name: "Blog", color: "blue" },
          { id: "newsletter", name: "Newsletter", color: "purple" },
          { id: "community", name: "Community", color: "green" },
          { id: "video", name: "Video", color: "red" },
          { id: "docs", name: "Docs", color: "gray" },
        ],
      },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { id: "idea", name: "Idea", color: "gray" },
          { id: "drafting", name: "Drafting", color: "yellow" },
          { id: "review", name: "In review", color: "purple" },
          { id: "scheduled", name: "Scheduled", color: "blue" },
          { id: "published", name: "Published", color: "green" },
        ],
      },
      { name: "Publish", type: "DATE" },
      { name: "Author", type: "PEOPLE" },
      { name: "Words", type: "NUMBER" },
      { name: "Cover", type: "FILES" },
      {
        name: "Tags",
        type: "MULTI_SELECT",
        options: [
          { id: "launch", name: "launch", color: "red" },
          { id: "product", name: "product", color: "purple" },
          { id: "engineering", name: "engineering", color: "blue" },
          { id: "design", name: "design", color: "pink" },
          { id: "research", name: "research", color: "green" },
          { id: "culture", name: "culture", color: "orange" },
        ],
      },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Calendar", type: "CALENDAR" },
      { name: "Gallery", type: "GALLERY", config: { previewPropertyId: "Cover" } },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Status" } },
    ],
    rows: [
      {
        title: "Your databases, inside your documents",
        icon: "🚀",
        coverUrl: cover(PHOTOS.charts),
        values: {
          Channel: { optionId: "blog" },
          Status: { optionId: "scheduled" },
          Publish: { start: "2026-10-20" },
          Author: { names: ["Sofia Lindqvist"] },
          Words: { number: 940 },
          Cover: { files: [{ name: "roadmap.png", url: cover(PHOTOS.charts), mimeType: "image/png" }] },
          Tags: { optionIds: ["launch", "product"] },
        },
      },
      {
        title: "v2.0 changelog",
        icon: "📝",
        coverUrl: cover(PHOTOS.laptops),
        values: {
          Channel: { optionId: "docs" },
          Status: { optionId: "review" },
          Publish: { start: "2026-10-19" },
          Author: { names: ["Priya Raman"] },
          Words: { number: 620 },
          Cover: { files: [{ name: "changelog.png", url: cover(PHOTOS.laptops), mimeType: "image/png" }] },
          Tags: { optionIds: ["launch", "engineering"] },
        },
      },
      {
        title: "Why we virtualised the editor",
        icon: "⚡",
        coverUrl: cover(PHOTOS.workspace),
        values: {
          Channel: { optionId: "blog" },
          Status: { optionId: "drafting" },
          Publish: { start: "2026-11-03" },
          Author: { names: ["Tomás Ferreira"] },
          Words: { number: 1280 },
          Cover: { files: [{ name: "editor.png", url: cover(PHOTOS.workspace), mimeType: "image/png" }] },
          Tags: { optionIds: ["engineering", "product"] },
        },
      },
      {
        title: "October newsletter",
        icon: "✉️",
        coverUrl: cover(PHOTOS.meeting),
        values: {
          Channel: { optionId: "newsletter" },
          Status: { optionId: "scheduled" },
          Publish: { start: "2026-10-27" },
          Author: { names: ["Amara Okafor"] },
          Words: { number: 410 },
          Cover: { files: [{ name: "newsletter.png", url: cover(PHOTOS.meeting), mimeType: "image/png" }] },
          Tags: { optionIds: ["launch"] },
        },
      },
      {
        title: "60-second demo video",
        icon: "🎬",
        coverUrl: cover(PHOTOS.design),
        values: {
          Channel: { optionId: "video" },
          Status: { optionId: "drafting" },
          Publish: { start: "2026-10-20" },
          Author: { names: ["Sofia Lindqvist"] },
          Words: { number: 0 },
          Cover: { files: [{ name: "demo.png", url: cover(PHOTOS.design), mimeType: "image/png" }] },
          Tags: { optionIds: ["launch"] },
        },
      },
      {
        title: "What we learned from 12 usability sessions",
        icon: "🔍",
        coverUrl: cover(PHOTOS.whiteboard),
        values: {
          Channel: { optionId: "blog" },
          Status: { optionId: "idea" },
          Publish: { start: "2026-11-10" },
          Author: { names: ["Priya Raman"] },
          Words: { number: 0 },
          Cover: { files: [{ name: "research.png", url: cover(PHOTOS.whiteboard), mimeType: "image/png" }] },
          Tags: { optionIds: ["research", "design"] },
        },
      },
      {
        title: "How we run a remote product team",
        icon: "🌍",
        coverUrl: cover(PHOTOS.team),
        values: {
          Channel: { optionId: "blog" },
          Status: { optionId: "published" },
          Publish: { start: "2026-10-06" },
          Author: { names: ["Amara Okafor"] },
          Words: { number: 1120 },
          Cover: { files: [{ name: "team.png", url: cover(PHOTOS.team), mimeType: "image/png" }] },
          Tags: { optionIds: ["culture"] },
        },
      },
      {
        title: "Exporting your workspace, end to end",
        icon: "📦",
        coverUrl: cover(PHOTOS.desk),
        values: {
          Channel: { optionId: "docs" },
          Status: { optionId: "published" },
          Publish: { start: "2026-09-29" },
          Author: { names: ["Louis Marchand"] },
          Words: { number: 780 },
          Cover: { files: [{ name: "export.png", url: cover(PHOTOS.desk), mimeType: "image/png" }] },
          Tags: { optionIds: ["engineering"] },
        },
      },
      {
        title: "Community AMA — v2.0",
        icon: "💬",
        coverUrl: cover(PHOTOS.office),
        values: {
          Channel: { optionId: "community" },
          Status: { optionId: "scheduled" },
          Publish: { start: "2026-10-22" },
          Author: { names: ["Amara Okafor"] },
          Words: { number: 0 },
          Cover: { files: [{ name: "ama.png", url: cover(PHOTOS.office), mimeType: "image/png" }] },
          Tags: { optionIds: ["launch", "culture"] },
        },
      },
      {
        title: "Roadmap: what comes after v2.0",
        icon: "🗺️",
        coverUrl: cover(PHOTOS.analytics),
        values: {
          Channel: { optionId: "blog" },
          Status: { optionId: "idea" },
          Publish: { start: "2026-12-01" },
          Author: { names: ["Amara Okafor"] },
          Words: { number: 0 },
          Cover: { files: [{ name: "next.png", url: cover(PHOTOS.analytics), mimeType: "image/png" }] },
          Tags: { optionIds: ["product"] },
        },
      },
    ],
  },

  /* -------------------------------------------------------- team directory */
  {
    key: "team",
    title: "Team directory",
    icon: "👥",
    position: 9000,
    properties: [
      { name: "Name", type: "TEXT", primary: true },
      { name: "Role", type: "TEXT" },
      { name: "Location", type: "TEXT" },
      {
        name: "Timezone",
        type: "SELECT",
        options: [
          { id: "cet", name: "CET", color: "blue" },
          { id: "gmt", name: "GMT", color: "green" },
          { id: "est", name: "EST", color: "purple" },
          { id: "ist", name: "IST", color: "orange" },
        ],
      },
      { name: "Started", type: "DATE" },
      { name: "Email", type: "EMAIL" },
      {
        name: "Focus",
        type: "MULTI_SELECT",
        options: [
          { id: "product", name: "Product", color: "purple" },
          { id: "design", name: "Design", color: "pink" },
          { id: "engineering", name: "Engineering", color: "blue" },
          { id: "marketing", name: "Marketing", color: "orange" },
          { id: "support", name: "Support", color: "green" },
        ],
      },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Timezone" } },
      { name: "List", type: "LIST" },
    ],
    rows: [
      {
        title: "Demo User",
        icon: "👋",
        values: {
          Role: { text: "Workspace owner" },
          Location: { text: "Remote" },
          Timezone: { optionId: "cet" },
          Started: { start: "2026-01-05" },
          Email: { text: "demo@noema.local" },
          Focus: { optionIds: ["product", "engineering"] },
        },
      },
      {
        title: "Amara Okafor",
        icon: "🧭",
        values: {
          Role: { text: "Head of Product" },
          Location: { text: "Lisbon, PT" },
          Timezone: { optionId: "gmt" },
          Started: { start: "2023-04-17" },
          Email: { text: "amara@noema.local" },
          Focus: { optionIds: ["product", "marketing"] },
        },
      },
      {
        title: "Louis Marchand",
        icon: "🛠️",
        values: {
          Role: { text: "Staff Engineer" },
          Location: { text: "Lyon, FR" },
          Timezone: { optionId: "cet" },
          Started: { start: "2023-02-06" },
          Email: { text: "louis@noema.local" },
          Focus: { optionIds: ["engineering", "product"] },
        },
      },
      {
        title: "Priya Raman",
        icon: "🎨",
        values: {
          Role: { text: "Product Designer" },
          Location: { text: "Bengaluru, IN" },
          Timezone: { optionId: "ist" },
          Started: { start: "2024-01-15" },
          Email: { text: "priya@noema.local" },
          Focus: { optionIds: ["design", "product"] },
        },
      },
      {
        title: "Tomás Ferreira",
        icon: "⚡",
        values: {
          Role: { text: "Senior Engineer" },
          Location: { text: "Porto, PT" },
          Timezone: { optionId: "gmt" },
          Started: { start: "2024-06-03" },
          Email: { text: "tomas@noema.local" },
          Focus: { optionIds: ["engineering"] },
        },
      },
      {
        title: "Sofia Lindqvist",
        icon: "📣",
        values: {
          Role: { text: "Growth & Content" },
          Location: { text: "Stockholm, SE" },
          Timezone: { optionId: "cet" },
          Started: { start: "2025-03-10" },
          Email: { text: "sofia@noema.local" },
          Focus: { optionIds: ["marketing", "support"] },
        },
      },
    ],
  },

  /* ------------------------------------------------------- feature requests */
  {
    key: "requests",
    title: "Feature requests",
    icon: "💡",
    position: 6000,
    properties: [
      { name: "Request", type: "TEXT", primary: true },
      { name: "Votes", type: "NUMBER" },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { id: "new", name: "New", color: "gray" },
          { id: "review", name: "Under review", color: "yellow" },
          { id: "planned", name: "Planned", color: "blue" },
          { id: "shipped", name: "Shipped", color: "green" },
          { id: "declined", name: "Declined", color: "red" },
        ],
      },
      {
        name: "Source",
        type: "SELECT",
        options: [
          { id: "community", name: "Community", color: "green" },
          { id: "support", name: "Support", color: "blue" },
          { id: "sales", name: "Sales", color: "orange" },
          { id: "interview", name: "Interview", color: "purple" },
        ],
      },
      { name: "Customer", type: "RELATION", relation: "crm" },
      { name: "Requested", type: "DATE" },
      { name: "Notes", type: "TEXT" },
    ],
    views: [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", config: { groupByPropertyId: "Status" } },
      { name: "List", type: "LIST" },
    ],
    rows: [
      {
        title: "Inline databases on any page",
        icon: "🧩",
        values: {
          Votes: { number: 214 },
          Status: { optionId: "shipped" },
          Source: { optionId: "community" },
          Requested: { start: "2026-04-18" },
          Notes: { text: "The single most requested feature for two years. Shipped in v2.0." },
        },
      },
      {
        title: "Better search filters",
        icon: "🔎",
        values: {
          Votes: { number: 96 },
          Status: { optionId: "review" },
          Source: { optionId: "interview" },
          Requested: { start: "2026-09-24" },
          Notes: { text: "Filter by page, ticket or comment, and by author." },
        },
      },
      {
        title: "Audit log filters",
        icon: "🧾",
        values: {
          Votes: { number: 41 },
          Status: { optionId: "planned" },
          Source: { optionId: "sales" },
          Requested: { start: "2026-08-30" },
          Notes: { text: "Requested by two enterprise accounts for compliance reviews." },
        },
      },
      {
        title: "Offline mode for the desktop app",
        icon: "✈️",
        values: {
          Votes: { number: 132 },
          Status: { optionId: "planned" },
          Source: { optionId: "community" },
          Requested: { start: "2026-05-11" },
          Notes: { text: "The desktop build already runs locally; full offline sync is the open question." },
        },
      },
      {
        title: "Granular page permissions",
        icon: "🔐",
        values: {
          Votes: { number: 88 },
          Status: { optionId: "review" },
          Source: { optionId: "sales" },
          Requested: { start: "2026-07-02" },
          Notes: { text: "Per-page read/edit, and per-section restrictions inside a page." },
        },
      },
      {
        title: "Two-factor recovery codes",
        icon: "🔑",
        values: {
          Votes: { number: 57 },
          Status: { optionId: "planned" },
          Source: { optionId: "support" },
          Requested: { start: "2026-06-19" },
          Notes: { text: "Without recovery codes, 2FA is a support risk." },
        },
      },
      {
        title: "Import from Confluence",
        icon: "📥",
        values: {
          Votes: { number: 74 },
          Status: { optionId: "new" },
          Source: { optionId: "community" },
          Requested: { start: "2026-10-02" },
          Notes: { text: "Space export is well documented; the mapping is the work." },
        },
      },
      {
        title: "Public page analytics",
        icon: "📈",
        values: {
          Votes: { number: 23 },
          Status: { optionId: "new" },
          Source: { optionId: "community" },
          Requested: { start: "2026-09-15" },
          Notes: { text: "Aggregate view counts only, opt-in, no personal data." },
        },
      },
      {
        title: "Calendar sync (Google & Outlook)",
        icon: "📅",
        values: {
          Votes: { number: 119 },
          Status: { optionId: "review" },
          Source: { optionId: "support" },
          Requested: { start: "2026-06-01" },
          Notes: { text: "ICS import works today; two-way sync does not." },
        },
      },
      {
        title: "Zapier-style webhooks",
        icon: "🔌",
        values: {
          Votes: { number: 36 },
          Status: { optionId: "planned" },
          Source: { optionId: "sales" },
          Requested: { start: "2026-08-08" },
          Notes: { text: "Webhooks ship with the public API; a no-code builder is the follow-up." },
        },
      },
      {
        title: "Nested database relations",
        icon: "🪆",
        values: {
          Votes: { number: 29 },
          Status: { optionId: "new" },
          Source: { optionId: "interview" },
          Requested: { start: "2026-10-09" },
          Notes: { text: "Relate a row to a row that itself relates to another database." },
        },
      },
      {
        title: "A dark-only mobile theme",
        icon: "🌙",
        values: {
          Votes: { number: 11 },
          Status: { optionId: "declined" },
          Source: { optionId: "community" },
          Requested: { start: "2026-07-27" },
          Notes: { text: "The theme follows the system setting by design; a separate switch adds confusion." },
        },
      },
    ],
  },
];
