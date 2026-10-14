import { describe, expect, it } from "vitest";
import { TEMPLATES, templateContent, templateDefinition } from "@/lib/templates";

describe("templates", () => {
  it("exposes the expected built-ins", () => {
    expect(TEMPLATES.map((t) => t.id).sort()).toEqual(["decision", "meeting", "tasks", "weekly"]);
    expect(templateDefinition("meeting")?.label).toBe("Meeting notes");
    expect(templateDefinition("nope" as never)).toBeUndefined();
  });

  it("builds block content", () => {
    const meeting = templateContent("meeting");
    expect(meeting.length).toBeGreaterThan(3);
    expect(meeting.some((n) => n.type === "heading")).toBe(true);
    expect(meeting.some((n) => n.type === "taskList")).toBe(true);

    const tasks = templateContent("tasks");
    expect(tasks.some((n) => n.type === "taskList")).toBe(true);
    expect(templateContent("nope" as never)).toEqual([]);
  });
});
