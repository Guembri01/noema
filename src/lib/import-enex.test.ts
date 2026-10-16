import { describe, expect, it } from "vitest";
import {
  enmlToBlocks,
  enmlToText,
  parseEnex,
  type EnexBlock,
  type EnexNote,
} from "@/lib/import-enex";

const ENEX_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">`;

/** Wrap a note body in the tags a real `.enex` uses. */
function note(inner: string): string {
  return `<note>${inner}</note>`;
}

const FULL_EXPORT = `${ENEX_HEADER}
<en-export export-date="20260101T000000Z" application="Evernote" version="10.0">
${note(`
  <title>Grocery &amp; chores</title>
  <content>
    <![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><div>Milk &amp; eggs</div><div>Bread<br/>butter</div></en-note>]]>
  </content>
  <created>20260101T120000Z</created>
  <updated>20260102T130000Z</updated>
  <tag>home</tag>
  <tag>errands</tag>
  <tag>home</tag>
  <note-attributes><author>Ada</author></note-attributes>
  <resource>
    <data encoding="base64" hash="abc123">
      aGVsbG8=
    </data>
    <mime>image/png</mime>
    <width>640</width>
    <height>480</height>
    <resource-attributes>
      <file-name>photo.png</file-name>
      <source-url>https://example.com/photo.png</source-url>
    </resource-attributes>
  </resource>
`)}
</en-export>`;

describe("parseEnex (Evernote ENEX → notes)", () => {
  it("parses title, timestamps, tags and content of a single note", () => {
    const notes: EnexNote[] = parseEnex(FULL_EXPORT);

    expect(notes).toHaveLength(1);
    const [entry] = notes;
    expect(entry.title).toBe("Grocery & chores");
    expect(entry.created).toBe("20260101T120000Z");
    expect(entry.updated).toBe("20260102T130000Z");
    // Duplicates collapse, order preserved.
    expect(entry.tags).toEqual(["home", "errands"]);
    expect(entry.content).toBe("Milk & eggs\nBread\nbutter");
  });

  it("parses resources with mime, filename, base64 data, size, hash and source url", () => {
    const [entry] = parseEnex(FULL_EXPORT);

    expect(entry.resources).toHaveLength(1);
    expect(entry.resources[0]).toEqual({
      mime: "image/png",
      filename: "photo.png",
      data: "aGVsbG8=", // surrounding whitespace stripped
      width: 640,
      height: 480,
      hash: "abc123",
      sourceUrl: "https://example.com/photo.png",
    });
  });

  it("parses multiple notes in document order", () => {
    const xml = `${ENEX_HEADER}<en-export>
      ${note("<title>First</title><content><![CDATA[<en-note><div>1</div></en-note>]]></content>")}
      ${note("<title>Second</title><content><![CDATA[<en-note><div>2</div></en-note>]]></content>")}
    </en-export>`;

    expect(parseEnex(xml).map((entry) => entry.title)).toEqual(["First", "Second"]);
  });

  it("returns an empty array for non-string or empty input", () => {
    for (const junk of [null, undefined, 42, true, {}, [], "", "   "]) {
      expect(parseEnex(junk)).toEqual([]);
    }
  });

  it("returns an empty array when the export has no notes", () => {
    expect(parseEnex(`${ENEX_HEADER}<en-export></en-export>`)).toEqual([]);
    expect(parseEnex("<en-export><note-attributes/></en-export>")).toEqual([]);
  });

  it("defaults a missing or blank title to Untitled", () => {
    const xml = `<en-export>${note("<title>  </title>")}${note("")}</en-export>`;
    expect(parseEnex(xml).map((entry) => entry.title)).toEqual(["Untitled", "Untitled"]);
  });

  it("returns null timestamps and an empty tag list when they are absent", () => {
    const [entry] = parseEnex(`<en-export>${note("<title>Bare</title>")}</en-export>`);
    expect(entry.created).toBeNull();
    expect(entry.updated).toBeNull();
    expect(entry.tags).toEqual([]);
    expect(entry.resources).toEqual([]);
    expect(entry.content).toBe("");
  });

  it("decodes entities in tag values and drops blank ones", () => {
    const xml = `<en-export>${note(
      "<title>T</title><tag>a&amp;b</tag><tag> </tag><tag>c</tag>",
    )}</en-export>`;
    expect(parseEnex(xml)[0].tags).toEqual(["a&b", "c"]);
  });

  it("parses several resources, keyed independently", () => {
    const xml = `<en-export>${note(`
      <title>Two</title>
      <resource>
        <data encoding="base64">QUJD</data>
        <mime>image/jpeg</mime>
        <resource-attributes><file-name>a.jpg</file-name></resource-attributes>
      </resource>
      <resource>
        <data encoding="base64">REVG</data>
        <mime>application/pdf</mime>
      </resource>
    `)}</en-export>`;
    const [entry] = parseEnex(xml);

    expect(entry.resources.map((resource) => resource.mime)).toEqual([
      "image/jpeg",
      "application/pdf",
    ]);
    expect(entry.resources.map((resource) => resource.data)).toEqual(["QUJD", "REVG"]);
    expect(entry.resources[0].filename).toBe("a.jpg");
    expect(entry.resources[1].filename).toBeNull();
  });

  it("returns null resource fields when pieces are missing", () => {
    const xml = `<en-export>${note(
      "<title>R</title><resource><mime>image/png</mime></resource>",
    )}</en-export>`;
    expect(parseEnex(xml)[0].resources[0]).toEqual({
      mime: "image/png",
      filename: null,
      data: null,
      width: null,
      height: null,
      hash: null,
      sourceUrl: null,
    });
  });

  it("tolerates an unclosed note and title without throwing", () => {
    const notes = parseEnex("<en-export><note><title>Partial");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Partial");
    expect(notes[0].content).toBe("");
  });

  it("ignores notes hidden in XML comments", () => {
    const xml = `<en-export><!-- ${note("<title>Ghost</title>")} -->${note(
      "<title>Real</title>",
    )}</en-export>`;
    expect(parseEnex(xml).map((entry) => entry.title)).toEqual(["Real"]);
  });

  it("tolerates entity-escaped content written without CDATA", () => {
    const xml = `<en-export>${note(
      "<title>Escaped</title><content>&lt;en-note&gt;&lt;div&gt;Hi&lt;/div&gt;&lt;/en-note&gt;</content>",
    )}</en-export>`;
    expect(parseEnex(xml)[0].content).toBe("Hi");
  });

  it("handles an empty en-note body", () => {
    const xml = `<en-export>${note(
      "<title>Empty</title><content><![CDATA[<en-note/>]]></content>",
    )}</en-export>`;
    expect(parseEnex(xml)[0].content).toBe("");
  });

  it("normalizes CRLF and non-breaking spaces in content", () => {
    const xml = `<en-export>${note(
      `<title>WS</title><content><![CDATA[<en-note><div>a\r\nb\u00a0c</div></en-note>]]></content>`,
    )}</en-export>`;
    expect(parseEnex(xml)[0].content).toBe("a\nb c");
  });

  it("is deterministic across repeated runs", () => {
    expect(parseEnex(FULL_EXPORT)).toEqual(parseEnex(FULL_EXPORT));
  });

  it("never throws on malformed or truncated input", () => {
    const malformed = [
      "<en-export><note><content><![CDATA[<en-note>",
      "<en-export><note><title><<<>",
      "<note></note></note>",
      "<en-media hash='x'/>",
      "<en-export><note><resource><data>%%%not-base64%%%</data></resource></note></en-export>",
      "not xml at all",
      "<en-export>" + "<note>".repeat(50),
    ];
    for (const xml of malformed) {
      expect(() => parseEnex(xml)).not.toThrow();
    }
  });
});

describe("enmlToText (ENML → plain text)", () => {
  it("joins block divs with newlines", () => {
    expect(enmlToText("<en-note><div>one</div><div>two</div></en-note>")).toBe("one\ntwo");
  });

  it("converts <br> to a line break", () => {
    expect(enmlToText("<en-note><div>a<br/>b</div></en-note>")).toBe("a\nb");
  });

  it("decodes HTML entities", () => {
    expect(enmlToText("<en-note><div>5 &lt; 6 &amp;&amp; 7 &gt; 6</div></en-note>")).toBe(
      "5 < 6 && 7 > 6",
    );
  });

  it("renders headings and paragraphs as text", () => {
    expect(enmlToText("<en-note><h1>Title</h1><p>Body</p></en-note>")).toBe("Title\nBody");
  });

  it("renders bullet and ordered list items", () => {
    const enml = "<en-note><ul><li>a</li><li>b</li></ul><ol><li>first</li></ol></en-note>";
    expect(enmlToText(enml)).toBe("- a\n- b\n1. first");
  });

  it("renders todos with their checked state", () => {
    const enml =
      '<en-note><div><en-todo checked="true"/>Buy milk</div>' +
      '<div><en-todo checked="false"/>Call mom</div></en-note>';
    expect(enmlToText(enml)).toBe("[x] Buy milk\n[ ] Call mom");
  });

  it("renders media placeholders by mime type", () => {
    const enml =
      '<en-note><div>Before</div><en-media type="image/png" hash="h1"/>' +
      '<en-media type="application/pdf" hash="h2"/></en-note>';
    expect(enmlToText(enml)).toBe("Before\n[image]\n[file]");
  });

  it("returns an empty string for non-string input", () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      expect(enmlToText(junk)).toBe("");
    }
  });
});

describe("enmlToBlocks (ENML → block list)", () => {
  it("classifies paragraphs, headings and list items", () => {
    const blocks: EnexBlock[] = enmlToBlocks(
      "<en-note><h2>H</h2><p>P</p><li>L</li></en-note>",
    );
    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "H" },
      { type: "paragraph", text: "P" },
      { type: "listItem", text: "L", ordered: false },
    ]);
  });

  it("distinguishes ordered from unordered list items", () => {
    const blocks = enmlToBlocks("<en-note><ol><li>one</li></ol><ul><li>two</li></ul></en-note>");
    expect(blocks).toEqual([
      { type: "listItem", text: "one", ordered: true },
      { type: "listItem", text: "two", ordered: false },
    ]);
  });

  it("emits todo, media and divider blocks", () => {
    const blocks = enmlToBlocks(
      '<en-note><div><en-todo checked="true"/>Done</div><hr/>' +
        '<en-media type="image/png" hash="h"/></en-note>',
    );
    expect(blocks).toEqual([
      { type: "todo", text: "Done", checked: true },
      { type: "divider" },
      { type: "media", mime: "image/png", hash: "h" },
    ]);
  });

  it("returns an empty array for non-string input", () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      expect(enmlToBlocks(junk)).toEqual([]);
    }
  });

  it("never throws on malformed markup", () => {
    const malformed = [
      "<en-note><div>unclosed",
      "<en-note><ul><li>a<ol><li>b",
      "<en-note><<<>>></en-note>",
      "<en-note><en-media></en-note>",
    ];
    for (const enml of malformed) {
      expect(() => enmlToBlocks(enml)).not.toThrow();
    }
  });
});
