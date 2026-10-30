import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { estimateBlockHeight, LINE_HEIGHT, paginateBlocks, type PrintBlock } from "./print-layout";
import type { RichNode } from "./blocks";

/**
 * PDF space is measured in points (72/in); `print-layout` works in 96dpi
 * device-independent pixels (96/in), so 1px = 0.75pt.
 */
const PT_PER_PX = 0.75;

/** Row height for a table row, mirroring `print-layout`'s table measurement. */
const ROW_HEIGHT_PX = 32;

/**
 * The base-14 PDF fonts only encode Latin-1. A bundled font is ideal, but the
 * deployment may be offline and the repository does not ship one, so the
 * exporter probes for a Unicode-capable system face and falls back to the
 * standard fonts (with Latin-only cleaning) when none is present.
 */
const UNICODE_FONT_CANDIDATES = {
  regular: [
    process.env.NOEMA_PDF_FONT,
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\calibri.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ].filter((path): path is string => Boolean(path)),
  bold: [
    process.env.NOEMA_PDF_FONT_BOLD,
    "C:\\Windows\\Fonts\\segoeuib.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\calibrib.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ].filter((path): path is string => Boolean(path)),
} as const;

function firstExistingFont(paths: readonly string[]): string | null {
  for (const path of paths) {
    try {
      if (existsSync(path)) return path;
    } catch {
      // An unreadable/malformed path is simply not a candidate.
    }
  }
  return null;
}

/** Register a Unicode font when one is available. */
function registerFonts(pdf: PDFKit.PDFDocument): {
  body: string;
  bold: string;
  unicode: boolean;
} {
  const regular = firstExistingFont(UNICODE_FONT_CANDIDATES.regular);
  if (!regular) return { body: "Helvetica", bold: "Helvetica-Bold", unicode: false };
  const bold = firstExistingFont(UNICODE_FONT_CANDIDATES.bold) ?? regular;
  try {
    pdf.registerFont("NoemaBody", regular);
    pdf.registerFont("NoemaBold", bold);
    return { body: "NoemaBody", bold: "NoemaBold", unicode: true };
  } catch {
    return { body: "Helvetica", bold: "Helvetica-Bold", unicode: false };
  }
}

/** Keep only characters the PDF base-14 fonts can encode. */
function clean(value: string, unicode = false): string {
  return unicode ? value.trimEnd() : value.replace(/[^\u0000-\u00ff]/g, "").trimEnd();
}


function inline(nodes: RichNode[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === "mention") return `@${String(node.attrs?.label ?? "")}`;
      if (node.type === "inlineMath") return `$${String(node.attrs?.latex ?? "")}$`;
      return node.text ?? inline(node.content ?? []);
    })
    .join("");
}

/** A top-level block plus the measurement the paginator consumes. */
type LayoutBlock = PrintBlock & { node: RichNode | null };

/** Estimate a block's rendered height from its shape, before drawing it. */
function measure(node: RichNode): number {
  const type = node.type ?? "";
  const text = inline(node.content);
  switch (type) {
    case "heading":
      return estimateBlockHeight({ type, level: Number(node.attrs?.level ?? 1), text });
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "table":
      return estimateBlockHeight({ type, count: node.content?.length });
    case "image":
      return estimateBlockHeight({ type, height: Number(node.attrs?.height) });
    case "horizontalRule":
    case "divider":
      return estimateBlockHeight({ type });
    default:
      return estimateBlockHeight({ type, text });
  }
}

/**
 * Render a page document to a text-faithful PDF.
 *
 * Blocks are measured (`estimateBlockHeight`) and flowed into pages by
 * `paginateBlocks`, which applies the keep-together rules from
 * `print-layout` (`applyBreakRules`) — a heading travels with the block that
 * follows it and a list/quote is never orphaned from its lead-in. Each layout
 * page becomes one PDF page and every block is drawn at its resolved `y`, so a
 * break is a deliberate layout decision instead of pdfkit's opportunistic
 * auto-flow. The public shape of the export is unchanged: the title renders
 * first, followed by the document's blocks in order.
 */
export function docToPdf(title: string, doc: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 56 });
      const fonts = registerFonts(pdf);
      const cleanText = (value: string) => clean(value, fonts.unicode);
      const chunks: Buffer[] = [];
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);

      const leftMargin = pdf.page.margins.left;
      const topMargin = pdf.page.margins.top;
      const contentTopPt = topMargin;
      // Reserve the bottom margin too: `print-layout` only knows a top margin,
      // so the usable content box is `pageHeight - (top + bottom)`.
      const layoutOptions = {
        pageHeight: pdf.page.height / PT_PER_PX,
        marginTop: (topMargin + pdf.page.margins.bottom) / PT_PER_PX,
      };

      const titleText = cleanText(title || "Untitled");
      const root = doc as RichNode | null;
      const nodes: RichNode[] = Array.isArray(root?.content) ? root.content : [];

      const blocks: LayoutBlock[] = [
        {
          id: "__title__",
          type: "heading",
          height: estimateBlockHeight({ type: "heading", level: 1, text: titleText }),
          node: null,
        },
        ...nodes.map((node, index) => ({
          id: `b${index}`,
          type: node.type ?? "",
          height: measure(node),
          node,
        })),
      ];
      const byId = new Map(blocks.map((block) => [block.id, block]));

      /** Draw one node's content at an absolute page `y`. */
      function drawNode(node: RichNode | null, y: number): void {
        if (!node) {
          pdf.font(fonts.bold).fontSize(22).text(titleText, leftMargin, y);
          return;
        }
        switch (node.type) {
          case "heading": {
            const level = Number(node.attrs?.level ?? 1);
            pdf
              .font(fonts.bold)
              .fontSize(level === 1 ? 17 : level === 2 ? 14 : 12)
              .fillColor("#000000")
              .text(cleanText(inline(node.content)), leftMargin, y)
              .font(fonts.body);
            break;
          }
          case "paragraph":
            pdf
              .font(fonts.body)
              .fontSize(11)
              .fillColor("#000000")
              .text(cleanText(inline(node.content)) || " ", leftMargin, y);
            break;
          case "bulletList":
          case "orderedList":
          case "taskList":
            pdf.font(fonts.body).fontSize(11).fillColor("#000000");
            (node.content ?? []).forEach((item, index) => {
              const text = cleanText(
                inline(item.content?.flatMap((child) => child.content ?? []) ?? []),
              );
              const prefix = node.type === "orderedList" ? `${index + 1}. ` : "- ";
              pdf.text(
                prefix + text,
                leftMargin + 12,
                y + index * LINE_HEIGHT * PT_PER_PX,
              );
            });
            break;
          case "blockquote":
            pdf
              .font(fonts.body)
              .fontSize(11)
              .fillColor("#666666")
              .text("| " + cleanText(inline(node.content)), leftMargin + 12, y)
              .fillColor("#000000");
            break;
          case "codeBlock":
            pdf
              .font(fonts.unicode ? fonts.body : "Courier")
              .fontSize(9)
              .fillColor("#000000")
              .text(cleanText(inline(node.content)), leftMargin, y)
              .font(fonts.body);
            break;
          case "horizontalRule":
            pdf
              .strokeColor("#dddddd")
              .moveTo(leftMargin, y)
              .lineTo(pdf.page.width - leftMargin, y)
              .stroke();
            break;
          case "callout":
            pdf
              .font(fonts.body)
              .fontSize(11)
              .fillColor("#000000")
              .text(cleanText(inline(node.content)), leftMargin, y);
            break;
          case "table":
            pdf.font(fonts.body).fontSize(10).fillColor("#000000");
            (node.content ?? []).forEach((row, index) => {
              const cells = (row.content ?? []).map((cell) =>
                cleanText(inline(cell.content?.flatMap((child) => child.content ?? []) ?? [])),
              );
              pdf.text(cells.join("   |   "), leftMargin, y + index * ROW_HEIGHT_PX * PT_PER_PX);
            });
            break;
          case "image":
            pdf
              .font(fonts.body)
              .fontSize(10)
              .fillColor("#666666")
              .text("[image]", leftMargin, y)
              .fillColor("#000000");
            break;
          default:
            drawNodes(node.content, y);
        }
      }

      /** Draw a run of nodes stacked from `startY`, advancing by their measure. */
      function drawNodes(run: RichNode[] | undefined, startY: number): void {
        let y = startY;
        for (const child of run ?? []) {
          drawNode(child, y);
          y += measure(child) * PT_PER_PX;
        }
      }

      const pages = paginateBlocks(blocks, layoutOptions);
      pages.forEach((page, index) => {
        if (index > 0) pdf.addPage();
        for (const placed of page.blocks) {
          const block = byId.get(placed.id);
          if (!block) continue;
          drawNode(block.node, contentTopPt + placed.y * PT_PER_PX);
        }
      });

      pdf.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
