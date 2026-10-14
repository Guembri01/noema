/**
 * The workspace home gallery: the "Empty page / Empty database" quick starts
 * plus the workflow templates shown next to them, and the simpler block
 * templates used elsewhere. Definitions are data only — the server action in
 * `src/server/actions/home-templates.ts` turns them into real rows.
 */

import { TEMPLATES, type TemplateId } from "./templates";

export type GalleryAccent =
  | "green"
  | "blue"
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "purple"
  | "pink";

export type GalleryProperty = {
  name: string;
  type:
    | "TEXT"
    | "NUMBER"
    | "SELECT"
    | "STATUS"
    | "DATE"
    | "PEOPLE"
    | "CREATED_BY"
    | "CREATED_TIME";
  primary?: boolean;
  options?: { name: string; color: string }[];
};

export type GalleryRow = {
  title: string;
  values?: Record<string, unknown>;
};

export type GalleryTemplate = {
  id: string;
  label: string;
  description: string;
  emoji: string;
  accent: GalleryAccent;
  kind: "database";
  properties: GalleryProperty[];
  rows: GalleryRow[];
  boardBy?: string;
};

export const GALLERY_TEMPLATES: GalleryTemplate[] = [
  {
    id: "task-tracking",
    label: "Task tracking",
    description: "Stay organised with tasks, your way.",
    emoji: "✅",
    accent: "green",
    kind: "database",
    boardBy: "Status",
    properties: [
      { name: "Task name", type: "TEXT", primary: true },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { name: "Not started", color: "gray" },
          { name: "In progress", color: "blue" },
          { name: "Done", color: "green" },
        ],
      },
      { name: "Assignee", type: "PEOPLE" },
      { name: "Due", type: "DATE" },
    ],
    rows: [
      { title: "Draft the launch checklist", values: { Status: "Not started" } },
      { title: "Review the design handoff", values: { Status: "In progress" } },
      { title: "Ship the onboarding email", values: { Status: "Done" } },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    description: "Manage projects from start to finish.",
    emoji: "🚀",
    accent: "blue",
    kind: "database",
    boardBy: "Status",
    properties: [
      { name: "Project", type: "TEXT", primary: true },
      {
        name: "Status",
        type: "STATUS",
        options: [
          { name: "Not started", color: "gray" },
          { name: "In progress", color: "blue" },
          { name: "Done", color: "green" },
        ],
      },
      { name: "Owner", type: "PEOPLE" },
      { name: "Target date", type: "DATE" },
    ],
    rows: [
      { title: "Website refresh", values: { Status: "In progress" } },
      { title: "Mobile onboarding", values: { Status: "Not started" } },
      { title: "Q3 research report", values: { Status: "Done" } },
    ],
  },
  {
    id: "skills",
    label: "Skills",
    description: "Save reusable instructions for agents.",
    emoji: "🪄",
    accent: "gray",
    kind: "database",
    properties: [
      { name: "Skill name", type: "TEXT", primary: true },
      { name: "Description", type: "TEXT" },
      { name: "Files", type: "TEXT" },
    ],
    rows: [
      { title: "Weekly status update", values: { Description: "Summarise progress from the task database." } },
      { title: "Meeting follow-ups", values: { Description: "Turn meeting notes into action items." } },
      { title: "Release checklist", values: { Description: "Verify tests, migrations and docs before shipping." } },
    ],
  },
  {
    id: "document-center",
    label: "Document center",
    description: "Collaborate on documents in one hub.",
    emoji: "📄",
    accent: "red",
    kind: "database",
    properties: [
      { name: "Document name", type: "TEXT", primary: true },
      { name: "Created by", type: "CREATED_BY" },
      { name: "Creation date", type: "CREATED_TIME" },
    ],
    rows: [
      { title: "Product requirements" },
      { title: "Brand guidelines" },
      { title: "Customer interview notes" },
      { title: "Support playbook" },
    ],
  },
  {
    id: "brainstorm",
    label: "Brainstorm session",
    description: "Spark new ideas together.",
    emoji: "💡",
    accent: "orange",
    kind: "database",
    boardBy: "Priority",
    properties: [
      { name: "Idea", type: "TEXT", primary: true },
      { name: "Created by", type: "CREATED_BY" },
      {
        name: "Priority",
        type: "SELECT",
        options: [
          { name: "High", color: "red" },
          { name: "Medium", color: "yellow" },
          { name: "Low", color: "green" },
        ],
      },
    ],
    rows: [
      { title: "Offline mode for the mobile app", values: { Priority: "Medium" } },
      { title: "Templates gallery on the home page", values: { Priority: "High" } },
      { title: "Keyboard-first command palette", values: { Priority: "Low" } },
    ],
  },
  {
    id: "meeting-notes",
    label: "Meeting notes",
    description: "Turn meetings into action.",
    emoji: "📅",
    accent: "yellow",
    kind: "database",
    properties: [
      { name: "Meeting name", type: "TEXT", primary: true },
      { name: "Date", type: "DATE" },
      {
        name: "Category",
        type: "SELECT",
        options: [
          { name: "Presentation", color: "yellow" },
          { name: "Planning", color: "blue" },
          { name: "Meeting", color: "red" },
        ],
      },
    ],
    rows: [
      { title: "Weekly team sync", values: { Category: "Meeting" } },
      { title: "Roadmap planning", values: { Category: "Planning" } },
      { title: "Design review", values: { Category: "Presentation" } },
    ],
  },
];

export function galleryTemplate(id: string): GalleryTemplate | undefined {
  return GALLERY_TEMPLATES.find((template) => template.id === id);
}

/** Simpler block templates offered under "Other templates". */
export const OTHER_TEMPLATES: { id: TemplateId; label: string; hint: string }[] =
  TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    hint: template.hint,
  }));
