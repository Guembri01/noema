"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { currentMonth } from "@/lib/calendar-block";
import { CalendarBlockView } from "./calendar-block-view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    calendarBlock: {
      setCalendarBlock: (attrs?: { month?: string }) => ReturnType;
    };
  }
}



/**
 * An inline month calendar with lightweight, local events.
 *
 * It is deliberately a document node rather than a database view: `/calendar`
 * should work on any page, with no schema/property setup, and its events are
 * saved in the page JSON with the rest of the document. A database Calendar
 * view remains the right tool for rows/properties; this is the Notion-style
 * "calendar block" for a page.
 */
export const CalendarBlock = Node.create<{ locale: string }>({
  name: "calendarBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      month: { default: currentMonth() },
      /** JSON string so the attribute survives every JSON/HTML round-trip. */
      events: { default: "[]" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-calendar-block]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-calendar-block": "",
        "data-calendar-month": String(HTMLAttributes.month ?? currentMonth()),
      }),
    ];
  },

  addCommands() {
    return {
      setCalendarBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { month: attrs?.month ?? currentMonth(), events: "[]" },
          }),
    };
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props) => (
      <CalendarBlockView {...props} locale={locale} />
    ));
  },
});
