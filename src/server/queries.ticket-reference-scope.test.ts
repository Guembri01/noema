import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B108 — the read side of the ticket boundary.
 *
 * A ticket carries references to rows of other tables: a project, an assignee
 * and (for the drawer) its children. The list and detail selects took those
 * relations as they came, so a ticket that pointed at another workspace's rows
 * showed that project's name and that person's name and **e-mail address** in
 * the tracker of *this* workspace — and a foreign child inflated the child
 * count.
 *
 * The fake database below applies the filters the real one would, so a missing
 * workspace filter surfaces as a foreign row in the result.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";

type FakeUser = {
  id: string;
  name: string;
  email: string;
  /** Workspaces the user is a member of. */
  memberships: string[];
  /** Workspaces the user owns. */
  owned: string[];
};

type FakeProject = { id: string; name: string; icon: string | null; workspaceId: string };
type FakeLabel = { id: string; name: string; color: string; workspaceId: string };
type FakeTicket = {
  id: string;
  key: string;
  title: string;
  workspaceId: string;
  projectId: string | null;
  assigneeId: string | null;
  labelIds: string[];
  parentId: string | null;
};

const USERS: FakeUser[] = [
  {
    id: "u-a",
    name: "Ada",
    email: "ada@example.com",
    memberships: [WORKSPACE_A],
    owned: [],
  },
  {
    id: "u-b",
    name: "Bob",
    email: "bob@other.example",
    memberships: [WORKSPACE_B],
    owned: [],
  },
];

const PROJECTS: FakeProject[] = [
  { id: "p-a", name: "Project A", icon: null, workspaceId: WORKSPACE_A },
  { id: "p-b", name: "Project B", icon: null, workspaceId: WORKSPACE_B },
];

const LABELS: FakeLabel[] = [
  { id: "l-a", name: "Label A", color: "blue", workspaceId: WORKSPACE_A },
  { id: "l-b", name: "Label B", color: "red", workspaceId: WORKSPACE_B },
];

const TICKETS: FakeTicket[] = [
  {
    id: "t-a",
    key: "A-1",
    title: "Ticket A",
    workspaceId: WORKSPACE_A,
    projectId: "p-a",
    assigneeId: "u-a",
    labelIds: ["l-a"],
    parentId: null,
  },
  {
    // A legacy row of workspace A that points at workspace B's project, user
    // and label — written before the write path checked the workspace.
    id: "t-legacy",
    key: "A-2",
    title: "Legacy row",
    workspaceId: WORKSPACE_A,
    projectId: "p-b",
    assigneeId: "u-b",
    labelIds: ["l-b"],
    parentId: null,
  },
  {
    // A ticket of workspace B filed under a ticket of workspace A.
    id: "t-foreign-child",
    key: "B-1",
    title: "Foreign child",
    workspaceId: WORKSPACE_B,
    projectId: null,
    assigneeId: null,
    labelIds: [],
    parentId: "t-a",
  },
];

type UserWhere = {
  OR?: {
    memberships?: { some?: { workspaceId?: string } };
    ownedWorkspaces?: { some?: { id?: string } };
  }[];
};

type RelationSelect = {
  where?: { workspaceId?: string };
};

type TicketSelect = {
  project?: RelationSelect;
  assignee?: { where?: UserWhere };
  labels?: { where?: { label?: { workspaceId?: string } } };
  children?: RelationSelect;
  _count?: { select?: { children?: boolean | { where?: { workspaceId?: string } } } };
};

/** The project's row, or `null` when the select's filter excludes it. */
function projectFor(ticket: FakeTicket, select: TicketSelect) {
  const project = PROJECTS.find((row) => row.id === ticket.projectId) ?? null;
  if (!project) return null;
  const workspaceId = select.project?.where?.workspaceId;
  if (workspaceId && project.workspaceId !== workspaceId) return null;
  return project;
}

/** The assignee's row, or `null` when the select's filter excludes it. */
function assigneeFor(ticket: FakeTicket, select: TicketSelect) {
  const user = USERS.find((row) => row.id === ticket.assigneeId) ?? null;
  if (!user) return null;
  const where = select.assignee?.where;
  if (!where) return user;
  const matches = (where.OR ?? []).some((clause) => {
    const memberOf = clause.memberships?.some?.workspaceId;
    if (memberOf) return user.memberships.includes(memberOf);
    const owns = clause.ownedWorkspaces?.some?.id;
    if (owns) return user.owned.includes(owns);
    return false;
  });
  return matches ? user : null;
}

/** The ticket's labels, or only those of the select's workspace. */
function labelsFor(ticket: FakeTicket, select: TicketSelect) {
  const workspaceId = select.labels?.where?.label?.workspaceId;
  return ticket.labelIds
    .map((id) => LABELS.find((row) => row.id === id))
    .filter((row): row is FakeLabel => Boolean(row))
    .filter((row) => !workspaceId || row.workspaceId === workspaceId)
    .map((row) => ({ label: row }));
}

/** The ticket's children, or only those of the select's workspace. */
function childrenFor(ticket: FakeTicket, select: TicketSelect) {
  const workspaceId = select.children?.where?.workspaceId;
  return TICKETS.filter((row) => row.parentId === ticket.id).filter(
    (row) => !workspaceId || row.workspaceId === workspaceId,
  );
}

/** The child count, counted over the select's workspace. */
function childCount(ticket: FakeTicket, select: TicketSelect) {
  const counted = select._count?.select?.children;
  const workspaceId = typeof counted === "object" ? counted?.where?.workspaceId : undefined;
  return childrenFor(ticket, { ...select, children: { where: { workspaceId } } }).length;
}

const db = vi.hoisted(() => ({
  ticket: { findMany: vi.fn(), findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import { getTicketDetail, getTickets, getTicketsCursorPage, getTicketsPage } from "./queries";

beforeEach(() => {
  vi.clearAllMocks();

  db.ticket.findMany.mockImplementation(
    async (args: { where: { workspaceId: string }; select: TicketSelect }) => {
      const rows = TICKETS.filter((row) => row.workspaceId === args.where.workspaceId);
      return rows.map((row) => ({
        ...row,
        project: projectFor(row, args.select),
        milestone: null,
        assignee: assigneeFor(row, args.select),
        labels: labelsFor(row, args.select),
        _count: { children: childCount(row, args.select), comments: 0 },
      }));
    },
  );

  db.ticket.findFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string }; select: TicketSelect }) => {
      const row = TICKETS.find(
        (ticket) => ticket.id === args.where.id && ticket.workspaceId === args.where.workspaceId,
      );
      if (!row) return null;
      return {
        ...row,
        project: projectFor(row, args.select),
        milestone: null,
        assignee: assigneeFor(row, args.select),
        reporter: USERS[0],
        labels: labelsFor(row, args.select),
        children: childrenFor(row, args.select),
        activity: [],
      };
    },
  );
});

describe("getTickets — the tracker list (B108)", () => {
  it("does not show the name of a project of another workspace", async () => {
    const rows = await getTickets(WORKSPACE_A);

    expect(rows.map((row) => row.project?.name ?? null)).toEqual(["Project A", null]);
  });

  it("does not show the name and e-mail address of an assignee of another workspace", async () => {
    const rows = await getTickets(WORKSPACE_A);

    expect(rows.map((row) => row.assignee?.email ?? null)).toEqual(["ada@example.com", null]);
    expect(JSON.stringify(rows)).not.toContain("bob@other.example");
    expect(JSON.stringify(rows)).not.toContain("Bob");
  });

  it("does not show a label of another workspace", async () => {
    const rows = await getTickets(WORKSPACE_A);

    expect(rows.map((row) => row.labels)).toEqual([[{ label: LABELS[0] }], []]);
  });

  it("does not count a child ticket of another workspace", async () => {
    const rows = await getTickets(WORKSPACE_A);

    expect(rows.map((row) => row._count.children)).toEqual([0, 0]);
  });
});

describe("getTicketsPage — the tracker's paged list (B108)", () => {
  it("does not show a foreign assignee", async () => {
    const page = await getTicketsPage(WORKSPACE_A);

    expect(page.tickets.map((row) => row.assignee?.email ?? null)).toEqual(["ada@example.com", null]);
  });
});

describe("getTicketsCursorPage — GET /api/tickets (B108)", () => {
  it("does not show a foreign assignee", async () => {
    const page = await getTicketsCursorPage(WORKSPACE_A);

    expect(page.items.map((row) => row.assignee?.email ?? null)).toEqual(["ada@example.com", null]);
    expect(JSON.stringify(page.items)).not.toContain("bob@other.example");
  });
});

describe("getTicketDetail — the drawer's ticket (B108)", () => {
  it("does not show a foreign project, assignee or child", async () => {
    const detail = await getTicketDetail("t-legacy", WORKSPACE_A);

    expect(detail?.project).toBeNull();
    expect(detail?.assignee).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("bob@other.example");
  });

  it("does not list a child ticket of another workspace", async () => {
    const detail = await getTicketDetail("t-a", WORKSPACE_A);

    expect(detail?.children).toEqual([]);
  });
});
