import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds08 — the archive row, rendered statically: the selection `Switch`, the
 * status `Badge`, the archiver `Avatar` and the `Button` restore.
 */

vi.mock("@/server/actions/tickets", () => ({ restoreTicketAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ArchiveRow, archiveStatusTone, type ArchivedTicketRow } from "./ticket-archive-view";

const ticket: ArchivedTicketRow = {
  id: "t1",
  key: "ABC-9",
  title: "An archived ticket",
  status: "done",
  archivedAt: "2026-05-01T10:00:00.000Z",
  archivedByName: "Ada Lovelace",
};

describe("archiveStatusTone", () => {
  it("maps statuses to badge tones, defaulting to neutral", () => {
    expect(archiveStatusTone("done")).toBe("success");
    expect(archiveStatusTone("cancelled")).toBe("danger");
    expect(archiveStatusTone("in_progress")).toBe("warning");
    expect(archiveStatusTone("todo")).toBe("accent");
    expect(archiveStatusTone("mystery")).toBe("neutral");
  });
});

describe("ArchiveRow markup", () => {
  const html = renderToStaticMarkup(
    createElement(ArchiveRow, {
      ticket,
      locale: "en",
      selected: true,
      onSelectedChange: () => {},
      onRestore: () => {},
    }),
  );

  it("renders the identity and the restore button", () => {
    expect(html).toContain('data-testid="archive-row-t1"');
    expect(html).toContain("ABC-9");
    expect(html).toContain("An archived ticket");
    expect(html).toContain('data-testid="restore-ticket-t1"');
    expect(html).toContain("Restore");
  });

  it("uses a Switch for selection and a Badge for status", () => {
    expect(html).toContain('role="switch"');
    expect(html).toContain("data-tone=\"success\"");
    expect(html).toContain('data-selected="true"');
  });

  it("shows the archiver as an avatar", () => {
    expect(html).toContain("data-kind=");
  });
});
