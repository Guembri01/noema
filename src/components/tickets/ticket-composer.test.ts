import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TicketComposerForm,
  parseEstimate,
  ticketDraftFromForm,
  validateTicketDraft,
} from "./ticket-composer";

/**
 * dz07 — new-ticket composer. The estimate parser and draft validator are pure,
 * so they are pinned directly; the shared form body is rendered statically in
 * both variants, and in its invalid state, without a browser.
 */

type FormProps = ComponentProps<typeof TicketComposerForm>;

const BASE_PROPS: FormProps = {
  onSubmit: () => {},
  pending: false,
  projects: [{ id: "p1", name: "Apollo", icon: "🚀", milestones: [{ id: "m1", name: "Launch" }] }],
  members: [{ id: "u1", name: "Ada" }],
  labels: [{ id: "l1", name: "Bug", color: "red", count: 2 }],
  locale: "en",
  onCancel: () => {},
};

const render = (overrides: Partial<FormProps> = {}) =>
  renderToStaticMarkup(createElement(TicketComposerForm, { ...BASE_PROPS, ...overrides }));

/* -------------------------------------------------------------------------- */
/* Estimate parse / validate                                                   */
/* -------------------------------------------------------------------------- */

describe("parseEstimate", () => {
  it("treats a blank field as no estimate", () => {
    expect(parseEstimate("")).toEqual({ ok: true, value: null });
    expect(parseEstimate("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts a non-negative number, including zero and fractions", () => {
    expect(parseEstimate("3")).toEqual({ ok: true, value: 3 });
    expect(parseEstimate("0")).toEqual({ ok: true, value: 0 });
    expect(parseEstimate("1.5")).toEqual({ ok: true, value: 1.5 });
  });

  it("rejects junk and negatives", () => {
    expect(parseEstimate("abc")).toEqual({ ok: false, error: "Enter a number." });
    expect(parseEstimate("-1")).toEqual({ ok: false, error: "Estimate cannot be negative." });
  });
});

describe("validateTicketDraft", () => {
  it("requires a title", () => {
    const errors = validateTicketDraft({
      title: "  ",
      estimate: "",
      startDate: "",
      dueDate: "",
    });
    expect(errors.title).toBeTruthy();
    expect(errors.estimate).toBeUndefined();
    expect(errors.dueDate).toBeUndefined();
  });

  it("flags an invalid estimate", () => {
    expect(
      validateTicketDraft({ title: "Ship it", estimate: "nope", startDate: "", dueDate: "" })
        .estimate,
    ).toBeTruthy();
  });

  it("flags a due date before the start date", () => {
    const errors = validateTicketDraft({
      title: "Ship it",
      estimate: "2",
      startDate: "2026-03-10",
      dueDate: "2026-03-01",
    });
    expect(errors.dueDate).toBeTruthy();
  });

  it("passes a complete draft", () => {
    expect(
      validateTicketDraft({
        title: "Ship it",
        estimate: "2",
        startDate: "2026-03-01",
        dueDate: "2026-03-10",
      }),
    ).toEqual({});
  });
});

describe("ticketDraftFromForm", () => {
  it("reads the validated fields back out of a FormData", () => {
    const form = new FormData();
    form.set("title", "Ship it");
    form.set("estimate", "3");
    form.set("startDate", "2026-03-01");
    form.set("dueDate", "2026-03-10");
    expect(ticketDraftFromForm(form)).toEqual({
      title: "Ship it",
      estimate: "3",
      startDate: "2026-03-01",
      dueDate: "2026-03-10",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Static render                                                               */
/* -------------------------------------------------------------------------- */

describe("TicketComposerForm render", () => {
  it("renders the inline body idle", () => {
    const html = render();
    expect(html).toContain('data-variant="inline"');
    expect(html).toContain('data-testid="ticket-composer"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="priority"');
    expect(html).toContain('name="estimate"');
    expect(html).toContain('name="startDate"');
    expect(html).toContain('name="dueDate"');
    expect(html).toContain('name="projectId"');
    expect(html).toContain('name="assigneeId"');
    expect(html).toContain("Bug");
    expect(html).toContain("Create ticket");
    expect(html).not.toContain('role="alert"');
  });

  it("renders the dialog variant body", () => {
    const html = render({ variant: "dialog" });
    expect(html).toContain('data-variant="dialog"');
    expect(html).toContain('data-testid="ticket-composer"');
  });

  it("renders the milestone picker with nothing preselected", () => {
    const html = render();
    expect(html).toContain('aria-label="Ticket milestone"');
    expect(html).toMatch(/name="milestoneId" value=""/);
    // The option labels themselves (a bare name inside a project, project-qualified
    // while unscoped) come from `milestoneChoices`, pinned in src/lib/tickets.test.ts.
  });

  it("omits the milestone field when nothing owns a milestone", () => {
    const html = render({ projects: [{ id: "p1", name: "Apollo", icon: null }] });
    expect(html).not.toContain('name="milestoneId"');
  });

  it("renders an inline validation error per field", () => {
    const html = render({
      defaultErrors: { title: "Give the ticket a title.", dueDate: "Due date cannot be before the start date." },
    });
    expect(html).toContain("Give the ticket a title.");
    expect(html).toContain("Due date cannot be before the start date.");
    expect(html).toContain('role="alert"');
  });

  it("disables the controls while pending", () => {
    const html = render({ pending: true });
    expect(html).toContain('data-loading=""');
    expect(html).toMatch(/disabled=""/);
  });
});
