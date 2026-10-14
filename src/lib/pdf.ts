import PDFDocument from "pdfkit";
import type { RichNode } from "./blocks";

/** Keep only characters the PDF base-14 fonts can encode. */
function clean(value: string): string {
  return value.replace(/[^\u0000-\u00ff]/g, "").trimEnd();
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

/** Render a page document to a simple, text-faithful PDF. */
export function docToPdf(title: string, doc: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ size: "A4", margin: 56 });
      const chunks: Buffer[] = [];
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);

      pdf.font("Helvetica-Bold").fontSize(22).text(clean(title || "Untitled"));
      pdf.moveDown(0.5);

      const walk = (node: RichNode) => {
        switch (node.type) {
          case "heading": {
            const level = Number(node.attrs?.level ?? 1);
            pdf
              .moveDown(0.4)
              .font("Helvetica-Bold")
              .fontSize(level === 1 ? 17 : level === 2 ? 14 : 12)
              .text(clean(inline(node.content)))
              .font("Helvetica");
            break;
          }
          case "paragraph":
            pdf.fontSize(11).text(clean(inline(node.content)) || " ");
            break;
          case "bulletList":
          case "orderedList":
          case "taskList":
            (node.content ?? []).forEach((item, index) => {
              const text = clean(
                inline(item.content?.flatMap((child) => child.content ?? []) ?? []),
              );
              const prefix = node.type === "orderedList" ? `${index + 1}. ` : "- ";
              pdf.fontSize(11).text(prefix + text, { indent: 12 });
            });
            break;
          case "blockquote":
            pdf
              .fontSize(11)
              .fillColor("#666666")
              .text("| " + clean(inline(node.content)), { indent: 12 })
              .fillColor("#000000");
            break;
          case "codeBlock":
            pdf
              .font("Courier")
              .fontSize(9)
              .text(clean(inline(node.content)))
              .font("Helvetica");
            break;
          case "horizontalRule":
            pdf.moveDown(0.3);
            pdf
              .strokeColor("#dddddd")
              .moveTo(56, pdf.y)
              .lineTo(540, pdf.y)
              .stroke();
            pdf.moveDown(0.3);
            break;
          case "callout":
            pdf.fontSize(11).text(clean(inline(node.content)));
            break;
          case "table":
            (node.content ?? []).forEach((row) => {
              const cells = (row.content ?? []).map((cell) =>
                clean(inline(cell.content?.flatMap((child) => child.content ?? []) ?? [])),
              );
              pdf.fontSize(10).text(cells.join("   |   "));
            });
            break;
          case "image":
            pdf.fontSize(10).fillColor("#666666").text("[image]").fillColor("#000000");
            break;
          default:
            (node.content ?? []).forEach(walk);
        }
      };

      const root = doc as RichNode | null;
      (root?.content ?? []).forEach(walk);
      pdf.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
