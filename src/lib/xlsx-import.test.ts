import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { columnIndex, parseXlsxMatrix } from "./xlsx-import";

async function workbook(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

describe("columnIndex", () => {
  it("maps A1 references to zero-based columns", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("B2")).toBe(1);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("AB12")).toBe(27);
  });

  it("rejects malformed references", () => {
    expect(columnIndex("1A")).toBeNull();
    expect(columnIndex("A")).toBeNull();
    expect(columnIndex("")).toBeNull();
  });
});

describe("parseXlsxMatrix", () => {
  it("reads shared strings, inline strings, numbers and sparse cells", async () => {
    const bytes = await workbook({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        '<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Ada</t></si></sst>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>Hello &amp; bye</t></is></c></row>' +
        '<row r="3"><c r="B3"><v>42</v></c></row>' +
        "</sheetData></worksheet>",
    });
    const matrix = await parseXlsxMatrix(bytes);
    expect(matrix[0]).toEqual(["Name", "Score", ""]);
    expect(matrix[1]).toEqual(["Ada", "", "Hello & bye"]);
    expect(matrix[2]).toEqual(["", "42", ""]);
  });

  it("falls back to sheet1.xml and trims trailing empty rows", async () => {
    const bytes = await workbook({
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Only</t></is></c></row><row r="3"/></sheetData></worksheet>',
    });
    expect(await parseXlsxMatrix(bytes)).toEqual([["Only"]]);
  });

  it("refuses a workbook without a worksheet", async () => {
    const bytes = await workbook({ "xl/workbook.xml": "<workbook/>" });
    await expect(parseXlsxMatrix(bytes)).rejects.toThrow(/no readable worksheet/i);
  });
});
