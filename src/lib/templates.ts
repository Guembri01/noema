import type { RichNode } from "./blocks";

/**
 * Built-in block templates inserted by the "Template button" block (and a
 * basis for database templates later). Each builder returns a list of block
 * nodes inserted at the button's position.
 */

export type TemplateId = "meeting" | "tasks" | "decision" | "weekly";

const heading = (text: string, level = 2): RichNode => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});

const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

const bullets = (items: string[]): RichNode => ({
  type: "bulletList",
  content: items.map((item) => ({
    type: "listItem",
    content: [paragraph(item)],
  })),
});

const tasks = (items: string[]): RichNode => ({
  type: "taskList",
  content: items.map((item) => ({
    type: "taskItem",
    attrs: { checked: false },
    content: [paragraph(item)],
  })),
});

export type TemplateDefinition = {
  id: TemplateId;
  label: string;
  hint: string;
  build: () => RichNode[];
};

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: "meeting",
    label: "Meeting notes",
    hint: "Attendees, agenda, actions",
    build: () => [
      heading("Meeting notes"),
      heading("Attendees", 3),
      paragraph(""),
      heading("Agenda", 3),
      bullets(["Topic one", "Topic two"]),
      heading("Notes", 3),
      paragraph(""),
      heading("Action items", 3),
      tasks(["Follow up with…", "Draft the…"]),
    ],
  },
  {
    id: "tasks",
    label: "Task list",
    hint: "A ready-made checklist",
    build: () => [heading("Tasks"), tasks(["First task", "Second task", "Third task"])],
  },
  {
    id: "decision",
    label: "Decision log",
    hint: "Decision, context, consequences",
    build: () => [
      heading("Decision"),
      paragraph("What did we decide?"),
      heading("Context", 3),
      paragraph("Why now?"),
      heading("Consequences", 3),
      bullets(["Positive", "Negative", "Follow-ups"]),
    ],
  },
  {
    id: "weekly",
    label: "Weekly review",
    hint: "This week / next week",
    build: () => [
      heading("Weekly review"),
      heading("This week", 3),
      bullets(["Shipped", "Learned"]),
      heading("Next week", 3),
      bullets(["Plan", "Risks"]),
    ],
  },
];

export function templateDefinition(id: TemplateId): TemplateDefinition | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

export function templateContent(id: TemplateId): RichNode[] {
  return templateDefinition(id)?.build() ?? [];
}
