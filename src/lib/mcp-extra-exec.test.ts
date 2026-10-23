import { describe, expect, it } from "vitest";
import { encodePropertyValue, ensureBlockIds, isExtraTool } from "./mcp-extra-exec";

describe("MCP extended tool helpers", () => {
  it("encodes scalar values into the stored cell shapes", () => {
    expect(encodePropertyValue("TEXT", "hello")).toEqual({ text: "hello" });
    expect(encodePropertyValue("NUMBER", "42")).toEqual({ number: 42 });
    expect(encodePropertyValue("CHECKBOX", true)).toEqual({ checked: true });
    expect(encodePropertyValue("STATUS", "done")).toEqual({ optionId: "done" });
    expect(encodePropertyValue("MULTI_SELECT", ["a", "b"])).toEqual({
      optionIds: ["a", "b"],
    });
    expect(encodePropertyValue("DATE", "2026-10-23")).toEqual({
      start: "2026-10-23",
    });
    expect(encodePropertyValue("TEXT", { text: "already" })).toEqual({
      text: "already",
    });
  });

  it("assigns stable ids recursively and preserves existing ids", () => {
    const block = ensureBlockIds({
      type: "bulletList",
      content: [
        { type: "listItem", attrs: { id: "keep-me" }, content: [{ type: "paragraph" }] },
      ],
    });
    expect(block.attrs).toMatchObject({ id: expect.stringMatching(/^blk_/) });
    const child = (block.content as Record<string, unknown>[])[0];
    expect(child.attrs).toMatchObject({ id: "keep-me" });
    const grandchild = (child.content as Record<string, unknown>[])[0];
    expect(grandchild.attrs).toMatchObject({ id: expect.stringMatching(/^blk_/) });
  });

  it("recognizes extended names but not core names", () => {
    expect(isExtraTool("update_page")).toBe(true);
    expect(isExtraTool("share_manage")).toBe(true);
    expect(isExtraTool("get_page")).toBe(false);
    expect(isExtraTool("not_a_tool")).toBe(false);
  });
});
