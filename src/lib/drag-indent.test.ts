import { describe, expect, it } from "vitest";
import { Schema, Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type EditorState as State } from "@tiptap/pm/state";
import { analyzeBlockDrop, dropZone, DRAG_THRESHOLD_PX } from "@/lib/drag-indent";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    bulletList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph+" },
    taskList: { group: "block", content: "taskItem+" },
    taskItem: { content: "paragraph+" },
    text: { inline: true, group: "inline" },
  },
});

const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const li = (text: string) => schema.nodes.listItem.create(null, p(text));
const task = (text: string) => schema.nodes.taskItem.create(null, p(text));
const doc = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);

/** Position of the first text node containing `text`. */
function textPos(state: State, text: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(text)) found = pos;
    return found === -1;
  });
  return found;
}

/** Position of the outer node whose text content is `text`. */
function nodePos(state: State, type: string, text: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === type && node.textContent === text) found = pos;
    return found === -1;
  });
  return found;
}

function sliceOf(...nodes: PMNode[]): Slice {
  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

describe("dropZone", () => {
  it("stays an align for purely vertical drags", () => {
    expect(dropZone(100, 100)).toBe("align");
    expect(dropZone(100 + DRAG_THRESHOLD_PX - 1, 100)).toBe("align");
    expect(dropZone(100 - DRAG_THRESHOLD_PX + 1, 100)).toBe("align");
  });

  it("nests when the pointer travels right past the threshold", () => {
    expect(dropZone(100 + DRAG_THRESHOLD_PX, 100)).toBe("indent");
    expect(dropZone(180, 100)).toBe("indent");
  });

  it("unnests when the pointer travels left past the threshold", () => {
    expect(dropZone(100 - DRAG_THRESHOLD_PX, 100)).toBe("outdent");
    expect(dropZone(40, 100)).toBe("outdent");
  });
});

describe("analyzeBlockDrop", () => {
  it("nests a dragged list item after the target and marks it to sink", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [li("A"), li("B")]),
        schema.nodes.bulletList.create(null, [li("X")]),
      ),
    });
    const sourcePos = nodePos(state, "listItem", "X");
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(li("X")),
      moved: true,
      dropPos: textPos(state, "A"),
      zone: "indent",
      sourcePos,
    });
    expect(plan).not.toBeNull();
    expect(plan!.node.type.name).toBe("listItem");
    expect(plan!.nest).toEqual({ itemType: "listItem" });
    // X is its list's only child: the range covers the whole (source) list so
    // the move cannot leave an empty bulletList shell behind.
    const $source = state.doc.resolve(sourcePos);
    const listDepth = $source.depth;
    expect(plan!.source).toEqual({
      from: $source.before(listDepth),
      to: $source.after(listDepth),
    });
    const $insert = state.doc.resolve(plan!.insertPos);
    expect($insert.parent.type.name).toBe("bulletList");
    expect($insert.nodeBefore?.textContent).toBe("A");
  });

  it("wraps a plain paragraph into the target list item type before nesting", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [li("A")]),
        p("loose"),
      ),
    });
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(p("loose")),
      moved: true,
      dropPos: textPos(state, "A"),
      zone: "indent",
      sourcePos: nodePos(state, "paragraph", "loose"),
    });
    expect(plan).not.toBeNull();
    expect(plan!.node.type.name).toBe("listItem");
    expect(plan!.node.firstChild?.type.name).toBe("paragraph");
    expect(plan!.nest).toEqual({ itemType: "listItem" });
  });

  it("refuses to move a literal item into a task list", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.taskList.create(null, [task("T")]),
        schema.nodes.bulletList.create(null, [li("X")]),
      ),
    });
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(li("X")),
      moved: true,
      dropPos: textPos(state, "T"),
      zone: "indent",
      sourcePos: nodePos(state, "listItem", "X"),
    });
    expect(plan).toBeNull();
  });

  it("unnests a nested item beside the target's parent, without sinking", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [
          schema.nodes.listItem.create(null, [
            p("A"),
            schema.nodes.bulletList.create(null, [li("N1"), li("N2")]),
          ]),
          li("C"),
        ]),
      ),
    });
    const sourcePos = nodePos(state, "listItem", "N1");
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(li("N1")),
      moved: true,
      dropPos: textPos(state, "N2"),
      zone: "outdent",
      sourcePos,
    });
    expect(plan).not.toBeNull();
    expect(plan!.nest).toBeNull();
    expect(plan!.source.from).toBe(sourcePos);
    const $insert = state.doc.resolve(plan!.insertPos);
    expect($insert.parent.type.name).toBe("bulletList");
    expect($insert.depth).toBe(1); // outer list: one level up
    // Gap sits right after the target's parent item (whose paragraph is "A";
    // textContent also includes the nested list it wraps).
    expect($insert.nodeBefore?.type.name).toBe("listItem");
    expect($insert.nodeBefore?.firstChild?.textContent).toBe("A");
  });

  it("places an outdented item next to a root-level target in the same list", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [
          schema.nodes.listItem.create(null, [
            p("A"),
            schema.nodes.bulletList.create(null, [li("N1")]),
          ]),
          li("C"),
        ]),
      ),
    });
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(li("N1")),
      moved: true,
      dropPos: textPos(state, "C"),
      zone: "outdent",
      sourcePos: nodePos(state, "listItem", "N1"),
    });
    expect(plan).not.toBeNull();
    expect(plan!.nest).toBeNull();
    const $insert = state.doc.resolve(plan!.insertPos);
    expect($insert.nodeBefore?.textContent).toBe("C");
  });

  it("widens the source to the parent list when the item is its list's only child", () => {
    // ProseMirror's replace fitter keeps a minimal listItem shell rather than
    // leaving a bulletList empty (bulletList content is `listItem+`), so
    // deleting only the item would leave an empty bullet behind after the
    // move. The delete range must therefore cover the whole parent list.
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [
          schema.nodes.listItem.create(null, [
            p("A"),
            schema.nodes.bulletList.create(null, [li("N")]),
          ]),
        ]),
      ),
    });
    const sourcePos = nodePos(state, "listItem", "N");
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(li("N")),
      moved: true,
      dropPos: textPos(state, "A"),
      zone: "outdent",
      sourcePos,
    });
    expect(plan).not.toBeNull();
    expect(plan!.nest).toBeNull();
    const $source = state.doc.resolve(sourcePos);
    const listDepth = $source.depth;
    expect(plan!.source).toEqual({
      from: $source.before(listDepth),
      to: $source.after(listDepth),
    });
    // Wider than the narrow item range the fitter would choke on.
    expect(plan!.source.from).toBeLessThan(sourcePos);
  });

  it("falls back to the stock drop for align zones and multi-block drags", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [li("A"), li("B")]),
        p("tail"),
      ),
    });
    expect(
      analyzeBlockDrop(state, {
        slice: sliceOf(li("B")),
        moved: true,
        dropPos: textPos(state, "A"),
        zone: "align",
        sourcePos: nodePos(state, "listItem", "B"),
      }),
    ).toBeNull();
    expect(
      analyzeBlockDrop(state, {
        slice: sliceOf(li("B"), p("tail")),
        moved: true,
        dropPos: textPos(state, "A"),
        zone: "indent",
        sourcePos: nodePos(state, "listItem", "B"),
      }),
    ).toBeNull();
  });

  it("falls back when the dragged slice wraps a whole multi-item list", () => {
    const state = EditorState.create({
      doc: doc(
        schema.nodes.bulletList.create(null, [li("A")]),
        schema.nodes.bulletList.create(null, [li("X1"), li("X2")]),
      ),
    });
    const plan = analyzeBlockDrop(state, {
      slice: sliceOf(schema.nodes.bulletList.create(null, [li("X1"), li("X2")])),
      moved: true,
      dropPos: textPos(state, "A"),
      zone: "indent",
      sourcePos: nodePos(state, "bulletList", "X1X2"),
    });
    expect(plan).toBeNull();
  });
});
