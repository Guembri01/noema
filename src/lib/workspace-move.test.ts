import { describe, expect, it } from "vitest";
import {
  checkAccess,
  collisionReport,
  planWorkspaceMove,
  remapRefs,
  summarizeMove,
  validateMove,
} from "@/lib/workspace-move";
import type {
  IdFactory,
  MovePage,
  WorkspaceMoveInput,
  WorkspaceMovePlan,
} from "@/lib/workspace-move";

/** Deterministic factory: `new-1`, `new-2`, … in allocation order. */
function seqFactory(start = 1): IdFactory {
  let n = start - 1;
  return () => {
    n += 1;
    return `new-${n}`;
  };
}

/** Read a node's `attrs`, typed loosely so expectations stay readable. */
function attrsOf(value: unknown): Record<string, unknown> {
  return (value as { attrs: Record<string, unknown> }).attrs;
}

const remapTable = new Map([
  ["p-a", "new-a"],
  ["p-b", "new-b"],
]);

describe("remapRefs", () => {
  it("rewrites a mention's pageId to the mapped id", () => {
    const input = { type: "mention", attrs: { pageId: "p-a", label: "Alpha" } };
    const { content, dangling } = remapRefs(input, remapTable);
    expect(attrsOf(content).pageId).toBe("new-a");
    expect(dangling).toEqual([]);
  });

  it("rewrites embedded pages, including the pageEmbed alias", () => {
    const embed = remapRefs({ type: "embed", attrs: { pageId: "p-b" } }, remapTable);
    const pageEmbed = remapRefs({ type: "pageEmbed", attrs: { targetId: "p-a" } }, remapTable);
    expect(attrsOf(embed.content).pageId).toBe("new-b");
    expect(attrsOf(pageEmbed.content).targetId).toBe("new-a");
    expect(embed.dangling).toEqual([]);
    expect(pageEmbed.dangling).toEqual([]);
  });

  it("rewrites every element of a relation's id array", () => {
    const input = { type: "relation", attrs: { pageIds: ["p-a", "p-b"], refIds: ["p-b"] } };
    const { content, dangling } = remapRefs(input, remapTable);
    expect(attrsOf(content).pageIds).toEqual(["new-a", "new-b"]);
    expect(attrsOf(content).refIds).toEqual(["new-b"]);
    expect(dangling).toEqual([]);
  });

  it("leaves already-mapped references alone and reports unmapped ones", () => {
    const input = { type: "mention", attrs: { pageId: "p-a" } };
    const { content } = remapRefs(input, remapTable);
    expect(attrsOf(content).pageId).toBe("new-a");
    const unknown = remapRefs({ type: "mention", attrs: { pageId: "ghost" } }, remapTable);
    expect(attrsOf(unknown.content).pageId).toBe("ghost");
    expect(unknown.dangling).toEqual([{ kind: "mention", id: "ghost", path: "attrs.pageId" }]);
  });

  it("flags each dangling id inside an array, with its index in the path", () => {
    const input = { type: "relation", attrs: { pageIds: ["p-a", "ghost", "missing"] } };
    const { content, dangling } = remapRefs(input, remapTable);
    expect(attrsOf(content).pageIds).toEqual(["new-a", "ghost", "missing"]);
    expect(dangling).toEqual([
      { kind: "relation", id: "ghost", path: "attrs.pageIds[1]" },
      { kind: "relation", id: "missing", path: "attrs.pageIds[2]" },
    ]);
  });

  it("recurses into nested content and children, keeping full paths", () => {
    const input = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { pageId: "p-a" } }] }],
      children: [{ type: "relation", attrs: { pageIds: ["p-b"] } }],
    };
    const { content, dangling } = remapRefs(input, remapTable);
    const body = content as { content: unknown[]; children: unknown[] };
    expect(attrsOf((body.content[0] as { content: unknown[] }).content[0]).pageId).toBe("new-a");
    expect(attrsOf(body.children[0]).pageIds).toEqual(["new-b"]);
    expect(dangling).toEqual([]);
  });

  it("reports a dangling reference in a nested path", () => {
    const input = { blocks: [{ type: "mention", attrs: { pageId: "ghost" } }] };
    const { dangling } = remapRefs(input, remapTable);
    expect(dangling).toEqual([
      { kind: "mention", id: "ghost", path: "blocks[0].attrs.pageId" },
    ]);
  });

  it("drops dangling references when asked, without mutating the input", () => {
    const input = { type: "mention", attrs: { pageId: "ghost", label: "G" } };
    const before = JSON.stringify(input);
    const { content, dangling } = remapRefs(input, remapTable, { dropDangling: true });
    expect(attrsOf(content).pageId).toBeNull();
    expect(attrsOf(content).label).toBe("G");
    expect(dangling).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("passes non-object content straight through", () => {
    expect(remapRefs("plain", remapTable)).toEqual({ content: "plain", dangling: [] });
    expect(remapRefs(null, remapTable)).toEqual({ content: null, dangling: [] });
    expect(remapRefs([1, 2], remapTable)).toEqual({ content: [1, 2], dangling: [] });
  });
});

/** A small source workspace: an internal subtree plus a page staying behind. */
function sourcePages(): MovePage[] {
  return [
    {
      id: "p-root",
      parentId: null,
      title: "Root",
      createdById: "u1",
      blocks: [
        { id: "b1", type: "paragraph", content: [{ type: "text", text: "hi" }] },
        { id: "b2", type: "mention", attrs: { pageId: "p-a", label: "Alpha" } },
      ],
    },
    {
      id: "p-a",
      parentId: "p-root",
      title: "Alpha",
      createdById: "u2",
      blocks: [{ id: "b3", type: "pageEmbed", attrs: { pageId: "p-missing", title: "Gone" } }],
    },
    { id: "p-b", parentId: "p-external", title: "Beta", createdById: "u3" },
    { id: "p-other", parentId: null, title: "Other" },
  ];
}

function moveInput(overrides: Partial<WorkspaceMoveInput> = {}): WorkspaceMoveInput {
  return {
    pages: sourcePages(),
    subtreeIds: ["p-root", "p-a", "p-b"],
    fromWorkspaceId: "ws-from",
    toWorkspaceId: "ws-to",
    membersFrom: ["u1", "u2"],
    membersTo: ["u1"],
    idFactory: seqFactory(),
    ...overrides,
  };
}

function validPlan(): WorkspaceMovePlan {
  return planWorkspaceMove(moveInput());
}

describe("planWorkspaceMove", () => {
  it("assigns fresh ids and an id map covering only the moved subtree", () => {
    const plan = validPlan();
    expect(plan.pages.map((p) => p.id)).toEqual(["new-1", "new-2", "new-3"]);
    expect(plan.idMap.get("p-root")).toBe("new-1");
    expect(plan.idMap.get("p-a")).toBe("new-2");
    expect(plan.idMap.has("p-other")).toBe(false);
    expect(plan.idMap.size).toBe(3);
  });

  it("remaps internal parent links and keeps the moved root at the top level", () => {
    const plan = validPlan();
    expect(plan.pages[0].parentId).toBeNull();
    expect(plan.pages[1].parentId).toBe("new-1");
  });

  it("drops a parent left behind and warns", () => {
    const plan = validPlan();
    expect(plan.pages[2].parentId).toBeNull();
    expect(plan.warnings).toContainEqual({
      code: "parent-left-behind",
      pageId: "new-3",
      refId: "p-external",
      message: "parent p-external is not part of the move; page was placed at the top level",
    });
  });

  it("remaps references that land inside the move", () => {
    const plan = validPlan();
    const blocks = plan.pages[0].blocks as { attrs: Record<string, unknown> }[];
    expect(blocks[1].attrs.pageId).toBe("new-2");
  });

  it("drops references to entities missing from the target and warns", () => {
    const plan = validPlan();
    const blocks = plan.pages[1].blocks as { attrs: Record<string, unknown> }[];
    expect(blocks[0].attrs.pageId).toBeNull();
    expect(plan.warnings).toContainEqual({
      code: "ref-dangling",
      pageId: "new-2",
      refId: "p-missing",
      message: "dropped dangling embed reference to p-missing (not present in the target workspace)",
    });
  });

  it("creates memberships for authors carried over from the source workspace", () => {
    const plan = validPlan();
    expect(plan.createMemberships).toEqual([
      { workspaceId: "ws-to", userId: "u2", role: "MEMBER" },
    ]);
  });

  it("drops an author unknown to both workspaces and warns", () => {
    const plan = planWorkspaceMove(moveInput({ membersFrom: ["u1"] }));
    const beta = plan.pages[2];
    expect(beta.createdById).toBeNull();
    expect(plan.warnings.some((w) => w.code === "member-missing" && w.refId === "u3")).toBe(true);
  });

  it("moves every page when subtreeIds is omitted", () => {
    const plan = planWorkspaceMove(moveInput({ subtreeIds: undefined }));
    expect(plan.pages).toHaveLength(4);
    expect(plan.idMap.has("p-other")).toBe(true);
  });

  it("moves nothing for an explicitly empty subtreeIds", () => {
    const plan = planWorkspaceMove(moveInput({ subtreeIds: [] }));
    expect(plan.pages).toEqual([]);
    expect(plan.idMap.size).toBe(0);
  });

  it("warns about subtree ids that name no known page", () => {
    const plan = planWorkspaceMove(moveInput({ subtreeIds: ["p-root", "nope"] }));
    expect(plan.warnings.some((w) => w.code === "unknown-subtree-id" && w.refId === "nope")).toBe(
      true,
    );
    expect(plan.pages.map((p) => p.id)).toEqual(["new-1"]);
  });

  it("records the source and target workspace ids", () => {
    const plan = validPlan();
    expect(plan.fromWorkspaceId).toBe("ws-from");
    expect(plan.toWorkspaceId).toBe("ws-to");
  });

  it("does not mutate the input pages", () => {
    const input = moveInput();
    const before = JSON.stringify(input.pages);
    planWorkspaceMove(input);
    expect(JSON.stringify(input.pages)).toBe(before);
  });

  it("tolerates pages without content", () => {
    const plan = planWorkspaceMove(
      moveInput({
        pages: [
          { id: "r", parentId: null, title: "R" },
          { id: "c", parentId: "r", title: "C" },
        ],
        subtreeIds: ["r", "c"],
        membersFrom: [],
        membersTo: [],
      }),
    );
    expect(plan.pages.map((p) => p.blocks)).toEqual([undefined, undefined]);
  });
});

describe("checkAccess", () => {
  it("allows a member into an unremarkable target workspace", () => {
    expect(checkAccess({ role: "MEMBER", targetWorkspacePolicy: {} })).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it("refuses a guest by default", () => {
    const result = checkAccess({ role: "GUEST", targetWorkspacePolicy: {} });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(["role GUEST may not move pages into the target workspace"]);
  });

  it("refuses a caller with no role in the target", () => {
    const result = checkAccess({ role: null, targetWorkspacePolicy: {} });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("no role in the target workspace");
  });

  it("honours an explicit allowedRoles override", () => {
    const policy = { allowedRoles: ["OWNER", "GUEST"] as const };
    expect(checkAccess({ role: "GUEST", targetWorkspacePolicy: policy }).allowed).toBe(true);
    expect(checkAccess({ role: "MEMBER", targetWorkspacePolicy: policy }).allowed).toBe(false);
  });

  it("refuses an archived or read-only target", () => {
    expect(checkAccess({ role: "OWNER", targetWorkspacePolicy: { status: "archived" } }).reasons).toEqual(
      ["target workspace is archived"],
    );
    expect(checkAccess({ role: "OWNER", targetWorkspacePolicy: { status: "read-only" } }).reasons).toEqual(
      ["target workspace is read-only"],
    );
  });

  it("refuses a move over the target page limit", () => {
    const policy = { maxPages: 2 };
    expect(checkAccess({ role: "MEMBER", targetWorkspacePolicy: policy, pageCount: 3 }).reasons).toEqual(
      ["move of 3 pages exceeds the target limit of 2"],
    );
    expect(checkAccess({ role: "MEMBER", targetWorkspacePolicy: policy, pageCount: 2 }).allowed).toBe(
      true,
    );
  });

  it("refuses incoming members whose role the target does not allow", () => {
    const policy = { allowedMemberRoles: ["ADMIN"] as const };
    const result = checkAccess({
      role: "OWNER",
      targetWorkspacePolicy: policy,
      incomingMembers: [{ workspaceId: "ws-to", userId: "u2", role: "MEMBER" }],
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(["member role MEMBER is not allowed in the target workspace"]);
  });

  it("accumulates every reason a move is refused", () => {
    const result = checkAccess({
      role: "GUEST",
      targetWorkspacePolicy: { status: "archived" },
    });
    expect(result.reasons).toEqual([
      "target workspace is archived",
      "role GUEST may not move pages into the target workspace",
    ]);
  });
});

describe("collisionReport", () => {
  const target = [
    { id: "t1", title: "Roadmap", path: "/work/roadmap" },
    { id: "t2", title: "Notes", path: "/notes" },
  ];

  it("detects a title collision, trimmed and case-insensitive", () => {
    const report = collisionReport([{ id: "p1", title: "  roadmap " }], target);
    expect(report).toEqual([
      { incomingId: "p1", kind: "title", existingId: "t1", value: "  roadmap " },
    ]);
  });

  it("detects a path collision", () => {
    const report = collisionReport([{ id: "p1", path: "/notes" }], target);
    expect(report).toEqual([{ incomingId: "p1", kind: "path", existingId: "t2", value: "/notes" }]);
  });

  it("reports both a title and a path collision for the same page", () => {
    const report = collisionReport([{ id: "p1", title: "Notes", path: "/notes" }], target);
    expect(report).toEqual([
      { incomingId: "p1", kind: "title", existingId: "t2", value: "Notes" },
      { incomingId: "p1", kind: "path", existingId: "t2", value: "/notes" },
    ]);
  });

  it("ignores blank names, unmatched pages and an empty target", () => {
    expect(collisionReport([{ id: "p1", title: "  ", path: "" }], target)).toEqual([]);
    expect(collisionReport([{ id: "p1", title: "Other" }], target)).toEqual([]);
    expect(collisionReport([{ id: "p1", title: "Roadmap" }], [])).toEqual([]);
  });
});

describe("summarizeMove", () => {
  it("counts pages, roots, memberships and warnings", () => {
    const summary = summarizeMove(validPlan());
    expect(summary.pageCount).toBe(3);
    expect(summary.rootIds).toEqual(["new-1", "new-3"]);
    expect(summary.membershipCount).toBe(1);
    expect(summary.fromWorkspaceId).toBe("ws-from");
    expect(summary.toWorkspaceId).toBe("ws-to");
    expect(summary.warningCount).toBe(3);
  });

  it("groups warnings by code", () => {
    const summary = summarizeMove(validPlan());
    expect(summary.warningsByCode).toEqual({
      "parent-left-behind": 1,
      "member-missing": 1,
      "ref-dangling": 1,
    });
  });

  it("summarizes an empty plan", () => {
    const summary = summarizeMove(planWorkspaceMove(moveInput({ subtreeIds: [] })));
    expect(summary).toEqual({
      fromWorkspaceId: "ws-from",
      toWorkspaceId: "ws-to",
      pageCount: 0,
      rootIds: [],
      membershipCount: 0,
      warningCount: 0,
      warningsByCode: {},
    });
  });
});

describe("validateMove", () => {
  it("accepts a plan produced by planWorkspaceMove", () => {
    expect(validateMove(validPlan())).toEqual({ ok: true, errors: [] });
  });

  it("flags a duplicate page id", () => {
    const plan = validPlan();
    plan.pages[1].id = plan.pages[0].id;
    const result = validateMove(plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`duplicate page id: ${plan.pages[0].id}`);
  });

  it("flags an orphaned parent link", () => {
    const plan = validPlan();
    plan.pages[1].parentId = "ghost";
    const result = validateMove(plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("orphaned parent: new-2 -> ghost");
  });

  it("flags a cycle left after remapping", () => {
    const plan = validPlan();
    plan.pages[0].parentId = plan.pages[1].id;
    const result = validateMove(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("cycle detected:"))).toBe(true);
  });

  it("flags a page the id map does not describe and an unmapped id map entry", () => {
    const plan = validPlan();
    plan.pages.pop(); // drop new-3, idMap still lists it
    plan.pages.push({ id: "extra", parentId: null, title: "Extra" });
    const result = validateMove(plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("page not in id map: extra");
    expect(result.errors).toContain("missing page for id map entry: new-3");
  });

  it("flags a page id carried over from the source workspace", () => {
    const plan = validPlan();
    plan.pages[0].id = "p-root";
    const result = validateMove(plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("page id reused from source: p-root");
  });
});
