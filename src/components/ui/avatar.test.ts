import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { presenceLabel, type AvatarUser } from "@/lib/avatars";
import {
  AVATAR_STATUSES,
  Avatar,
  AvatarGroup,
  avatarSizePx,
  initialsFontPx,
  isAvatarStatus,
  nearestAvatarSize,
  statusLabel,
  statusRingClass,
} from "./avatar";

/**
 * Avatar + AvatarGroup (§7). Node tests pin the size map, the status ring and
 * the stack overflow maths, then statically render image/initials, every size,
 * every status and a stack with `+N` (asserting `presenceLabel` names the tooltip).
 */

const u = (id: string, over: Partial<AvatarUser> = {}): AvatarUser => ({
  id,
  name: id.toUpperCase(),
  ...over,
});

const users: AvatarUser[] = [
  u("u1", { name: "Ada" }),
  u("u2", { name: "Bob" }),
  u("u3", { name: "Cy" }),
  u("u4", { name: "Dee" }),
  u("u5", { name: "Eve" }),
  u("u6", { name: "Fay" }),
];

const render = (props: Parameters<typeof Avatar>[0]) =>
  renderToStaticMarkup(createElement(Avatar, props));

describe("size map", () => {
  it("clamps into the 16–128 window and defaults to 32", () => {
    expect(avatarSizePx(16)).toBe(16);
    expect(avatarSizePx(128)).toBe(128);
    expect(avatarSizePx(200)).toBe(128);
    expect(avatarSizePx(4)).toBe(16);
    expect(avatarSizePx(undefined)).toBe(32);
    expect(avatarSizePx(Number.NaN)).toBe(32);
  });

  it("snaps an arbitrary size to the nearest sanctioned step", () => {
    expect(nearestAvatarSize(20)).toBe(16);
    expect(nearestAvatarSize(22)).toBe(24);
    expect(nearestAvatarSize(24)).toBe(24);
    expect(nearestAvatarSize(50)).toBe(64);
    expect(nearestAvatarSize(40)).toBe(32);
    expect(nearestAvatarSize(100)).toBe(128);
  });

  it("scales initials type with the box, never below 8px", () => {
    expect(initialsFontPx(16)).toBe(8);
    expect(initialsFontPx(32)).toBe(13);
    expect(initialsFontPx(128)).toBe(51);
  });
});

describe("status", () => {
  it("guards unknown statuses", () => {
    expect(isAvatarStatus("online")).toBe(true);
    expect(isAvatarStatus("offline")).toBe(false);
    expect(statusRingClass("nope")).toBe("");
    expect(statusLabel(undefined)).toBe("");
  });

  it("maps the three presences to status tokens", () => {
    expect(AVATAR_STATUSES).toEqual(["online", "away", "busy"]);
    expect(statusRingClass("online")).toBe("bg-success");
    expect(statusRingClass("away")).toBe("bg-warning");
    expect(statusRingClass("busy")).toBe("bg-danger");
    expect(statusLabel("busy")).toBe("Busy");
  });
});

describe("render", () => {
  it("renders initials via the avatar engine with a deterministic tint", () => {
    const html = render({ user: u("u1", { name: "Ada Lovelace" }) });
    expect(html).toContain('data-kind="initials"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ada Lovelace"');
    expect(html).toContain(">AL<");
    expect(html).toContain("background:#");
  });

  it("renders an image with alt for a usable avatarUrl", () => {
    const html = render({
      user: u("u1", { name: "Ada Lovelace", avatarUrl: "https://cdn.example/a.png" }),
    });
    expect(html).toContain('data-kind="image"');
    expect(html).toContain("<img");
    expect(html).toContain('alt="Ada Lovelace"');
    expect(html).toContain('src="https://cdn.example/a.png"');
  });

  it("sets a fixed box for every sanctioned size (no layout shift)", () => {
    for (const size of [16, 24, 32, 64, 128] as const) {
      const html = render({ user: u("u1", { name: "Ada" }), size });
      expect(html).toContain(`width:${size}px`);
      expect(html).toContain(`height:${size}px`);
    }
  });

  it("adds a labelled status ring", () => {
    const html = render({ user: u("u1", { name: "Ada" }), status: "online" });
    expect(html).toContain('data-status="online"');
    expect(html).toContain("bg-success");
    expect(html).toContain("Online");
  });
});

describe("AvatarGroup", () => {
  const renderGroup = (props: Parameters<typeof AvatarGroup>[0]) =>
    renderToStaticMarkup(createElement(AvatarGroup, props));

  it("collapses the overflow into +N and names the stack", () => {
    const html = renderGroup({ users, max: 4, size: 32 });
    const faces = html.split('data-kind="initials"').length - 1;
    expect(faces).toBe(4);
    expect(html).toContain("+2");
    expect(html).toContain(`aria-label="${presenceLabel(users)}"`);
    expect(html).toContain('title="Ada, Bob and 4 others"');
  });

  it("renders no overflow chip when everyone fits", () => {
    const html = renderGroup({ users: users.slice(0, 3), max: 5 });
    expect(html).not.toMatch(/\+\d/);
    expect(html.split('data-kind="initials"').length - 1).toBe(3);
  });

  it("excludes the viewer from the tooltip sentence", () => {
    const html = renderGroup({
      users: [u("a", { name: "Ada" }), u("b", { name: "Bob" })],
      max: 5,
      selfId: "a",
    });
    expect(html).toContain('aria-label="Bob"');
  });

  it("honours the overlap sizing without changing face boxes", () => {
    const html = renderGroup({ users, max: 4, size: 64 });
    expect(html).toContain("margin-inline-start:-18px");
    expect(html).toContain("width:64px");
  });
});
