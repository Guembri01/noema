import { describe, expect, it, vi } from "vitest";

/**
 * Pure mapping behind the "Who has access" roster: how a permission level
 * becomes a tag chip, and how the flat member list folds into the Owner /
 * Members / Guests / Invited groups. Both are exported from the component
 * module so the render path and the assertions share one definition.
 */

vi.mock("@/server/actions/page-permissions", () => ({
  listPagePermissionsAction: vi.fn(async () => []),
  setPagePermissionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { isTagHue } from "@/lib/design-tokens";
import {
  GROUP_LABELS,
  MEMBER_KINDS,
  ROLE_CHIPS,
  groupMemberRows,
  isMemberKind,
  roleChip,
  type AccessRow,
} from "./who-has-access";

const row = (over: Partial<AccessRow> & { userId: string }): AccessRow => ({
  name: "Ada Lovelace",
  email: "ada@example.test",
  level: null,
  ...over,
});

describe("roleChip", () => {
  it("maps every access level to its palette hue and label key", () => {
    expect(roleChip("NONE")).toEqual({ key: "NONE", hue: "gray", labelKey: "inheritRole" });
    expect(roleChip("READ")).toEqual({ key: "READ", hue: "gray", labelKey: "canView" });
    expect(roleChip("COMMENT")).toEqual({ key: "COMMENT", hue: "teal", labelKey: "canComment" });
    expect(roleChip("EDIT")).toEqual({ key: "EDIT", hue: "blue", labelKey: "canEdit" });
    expect(roleChip("FULL")).toEqual({ key: "FULL", hue: "purple", labelKey: "fullAccess" });
  });

  it("falls back to the inherit chip for null and unknown levels", () => {
    const none = { key: "NONE", hue: "gray", labelKey: "inheritRole" };
    expect(roleChip(null)).toEqual(none);
    expect(roleChip(undefined)).toEqual(none);
    expect(roleChip("SUPERUSER")).toEqual(none);
  });

  it("only ever emits a known tag hue", () => {
    for (const level of Object.keys(ROLE_CHIPS)) {
      expect(isTagHue(roleChip(level).hue)).toBe(true);
    }
  });
});

describe("isMemberKind", () => {
  it("accepts the four buckets and rejects everything else", () => {
    for (const kind of MEMBER_KINDS) expect(isMemberKind(kind)).toBe(true);
    expect(isMemberKind("admin")).toBe(false);
    expect(isMemberKind(null)).toBe(false);
    expect(isMemberKind(3)).toBe(false);
  });
});

describe("groupMemberRows", () => {
  it("buckets rows in Owner / Members / Guests / Invited order, regardless of input order", () => {
    const groups = groupMemberRows([
      row({ userId: "g1", kind: "guest" }),
      row({ userId: "m1" }), // no kind → member
      row({ userId: "o1", kind: "owner" }),
      row({ userId: "i1", kind: "invited" }),
      row({ userId: "m2", kind: "member" }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["owner", "member", "guest", "invited"]);
    expect(groups[0].rows.map((entry) => entry.userId)).toEqual(["o1"]);
    expect(groups[1].rows.map((entry) => entry.userId)).toEqual(["m1", "m2"]);
    expect(groups[2].rows.map((entry) => entry.userId)).toEqual(["g1"]);
    expect(groups[3].rows.map((entry) => entry.userId)).toEqual(["i1"]);
  });

  it("omits empty buckets and drops rows with no usable id", () => {
    const groups = groupMemberRows([
      row({ userId: "a", kind: "owner" }),
      row({ userId: "  ", kind: "guest" }),
      null as unknown as AccessRow,
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("owner");
  });

  it("returns [] for missing or non-array input", () => {
    expect(groupMemberRows(null)).toEqual([]);
    expect(groupMemberRows(undefined)).toEqual([]);
    expect(groupMemberRows([])).toEqual([]);
  });

  it("labels every bucket", () => {
    for (const kind of MEMBER_KINDS) expect(GROUP_LABELS[kind]).toBeTruthy();
  });
});
