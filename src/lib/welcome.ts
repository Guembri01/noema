import type { BlockDoc } from "./blocks";

/**
 * The starter document every new workspace begins with. Kept as data (not
 * markup) so it flows through the same editor/store path as user content.
 */
export function welcomeDoc(): BlockDoc {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Welcome to Noema 👋" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Noema is an open-source, self-hosted workspace for notes, docs and databases. This page is a normal page — edit it however you like.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Try these" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Type " },
                  { type: "text", marks: [{ type: "code" }], text: "/" },
                  {
                    type: "text",
                    text: " on an empty line to insert a block.",
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Create nested pages from the sidebar." },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Create a database page to track tasks with table and board views.",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Everything is a page: documents, folders and database rows share one model.",
              },
            ],
          },
        ],
      },
      { type: "horizontalRule" },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            marks: [{ type: "italic" }],
            text: "Replace this page, or delete it and start fresh.",
          },
        ],
      },
    ],
  };
}
