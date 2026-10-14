// Creates the GIN index behind full-text search and backfills Page.searchText.
//
//   node --env-file=.env scripts/setup-search.mjs
//
// Safe to re-run. `npm run check:search` verifies the mirrors match the documents.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Flatten a ProseMirror document to text (mirrors `prosemirrorToText`). */
function docText(node) {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(docText).join(" ");
  let out = typeof node.text === "string" ? node.text : "";
  if (Array.isArray(node.content)) out += ` ${node.content.map(docText).join(" ")}`;
  return out;
}

const mirrorFor = (title, content) =>
  `${title ?? ""}\n${docText(content)}`.replace(/\s+/g, " ").trim().slice(0, 100_000);

console.log("1/3  creating the GIN index (expression index, so raw SQL)…");
await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "Page_searchText_idx"
  ON "Page"
  USING GIN (to_tsvector('english', coalesce("searchText", "title")))
`);
console.log("     index ready");

console.log("2/3  backfilling Page.searchText…");
const pages = await prisma.page.findMany({
  select: { id: true, title: true, content: true, searchText: true },
});
let updated = 0;
for (const page of pages) {
  const text = mirrorFor(page.title, page.content);
  if (page.searchText === text) continue;
  await prisma.page.update({ where: { id: page.id }, data: { searchText: text } });
  updated += 1;
}
console.log(`     ${updated}/${pages.length} page(s) updated`);

console.log("3/3  verifying the index is usable…");
const matches = await prisma.$queryRawUnsafe(
  `SELECT id FROM "Page" WHERE to_tsvector('english', coalesce("searchText", "title")) @@ websearch_to_tsquery('english', 'page') LIMIT 1`,
);
console.log(`     full-text query returned ${matches.length} row(s) -> search works`);
console.log("\nFull-text search is ready.");

await prisma.$disconnect();
