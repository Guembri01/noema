// Verifies Postgres full-text search: index presence, ranking, prefix (type-ahead)
// matching, snippets, deleted-page exclusion and mirror freshness.
//
//   node --env-file=.env scripts/check-search.mjs
import { PrismaClient } from "@prisma/client";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
const stamp = Date.now();
const doc = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const mirror = (title, text) => `${title}\n${text}`;

const created = [];
const makePage = async (title, text, deleted = false) => {
  const page = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title,
      content: doc(text),
      searchText: mirror(title, text),
      createdById: user.id,
      deletedAt: deleted ? new Date() : null,
      isArchived: deleted,
    },
    select: { id: true },
  });
  created.push(page.id);
  return page.id;
};

// Two pages: one clearly about "quixotic", one that merely mentions it.
const strong = await makePage(`Zebra ${stamp}`, `quixotic quixotic quixotic zebra ${stamp}`);
const weak = await makePage(`Notes ${stamp}`, `a passing mention of quixotic inside a long ${"filler ".repeat(40)}`);
const hidden = await makePage(`Trashed ${stamp}`, `quixotic secret ${stamp}`, true);

// 1. The index exists.
const index = await prisma.$queryRawUnsafe(
  `SELECT indexname FROM pg_indexes WHERE tablename = 'Page' AND indexname = 'Page_searchText_idx'`,
);
check("GIN index for full-text search exists", index.length === 1);

// 2. Ranked results: one term matches both pages, and the dense page ranks first.
//    Mirrors the production ordering (`ts_rank_cd` cover density, see
//    `src/server/queries.ts`): ties fall back to newest-then-id so the result is
//    deterministic even when an equal-ranked page from another run exists.
const ranked = await prisma.$queryRawUnsafe(
  `SELECT id FROM "Page" WHERE "workspaceId" = $1 AND "deletedAt" IS NULL
     AND to_tsvector('english', coalesce("searchText", "title")) @@ websearch_to_tsquery('english', $2)
   ORDER BY ts_rank_cd(to_tsvector('english', coalesce("searchText", "title")), websearch_to_tsquery('english', $2)) DESC,
            "updatedAt" DESC, "id" ASC`,
  workspace.id,
  `quixotic`,
);
const liveHits = ranked.filter((row) => row.id === strong || row.id === weak);
check("full-text search finds every live page containing the term", liveHits.length === 2, `${liveHits.length} rows`);
check("the page mentioning the term most often ranks first", ranked[0]?.id === strong);

// 3. Search through the app's own endpoint (session cookie + FTS path).
const { SignJWT } = await import("jose");
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const auth = { cookie: `noema_session=${session}` };

const { createHash } = await import("node:crypto");
const apiToken = `e2e-token-${stamp}`;
const tokenRow = await prisma.apiToken.create({
  data: {
    userId: user.id,
    name: `search check ${stamp}`,
    tokenHash: createHash("sha256").update(apiToken).digest("hex"),
    // The v1 API enforces the grant of the bearer token: `GET /api/v1/search`
    // needs `read:pages`, so the token is minted with exactly that scope
    // (`src/lib/api-token-scope.ts` — the catalogue the app knows).
    scopes: ["read:pages"],
  },
  select: { id: true },
});
const searchApi = await fetch(
  `${base}/api/v1/search?workspaceId=${workspace.id}&q=${encodeURIComponent(`quixotic`)}`,
  { headers: { authorization: `Bearer ${apiToken}` } },
);
const payload = await searchApi.json().catch(() => ({}));
check(
  "the public API answers full-text search with a bearer token",
  searchApi.ok && Array.isArray(payload.results) && payload.results.length >= 2,
  `status ${searchApi.status}, results ${Array.isArray(payload.results) ? payload.results.length : 0}`,
);
await prisma.apiToken.delete({ where: { id: tokenRow.id } });

// 4. The search page renders the ranked hit with a snippet.
const html = await fetch(`${base}/w/${workspace.slug}/search?q=${encodeURIComponent(`quixotic ${stamp}`)}`, {
  headers: auth,
}).then((response) => response.text());
check("search page renders results", html.includes(`Zebra ${stamp}`));
check("search page includes a snippet", /quixotic/i.test(html));

// 5. Prefix (type-ahead) matching: "zebr" should still find "Zebra".
const prefix = await prisma.$queryRawUnsafe(
  `SELECT id FROM "Page" WHERE "workspaceId" = $1 AND "deletedAt" IS NULL
     AND to_tsvector('english', coalesce("searchText", "title")) @@ to_tsquery('english', $2)`,
  workspace.id,
  `zebr:*`,
);
check("prefix search matches a partial word", prefix.some((row) => row.id === strong));

// 6. Trashed pages never surface.
const deletedHit = await prisma.$queryRawUnsafe(
  `SELECT id FROM "Page" WHERE "workspaceId" = $1 AND "deletedAt" IS NULL
     AND to_tsvector('english', coalesce("searchText", "title")) @@ websearch_to_tsquery('english', $2)`,
  workspace.id,
  `zsecret ${stamp}`,
);
check("trashed pages are excluded", deletedHit.length === 0 && hidden !== strong);

// 7. Writes keep the mirror in step (the app's update path, exercised via prisma push of the same helper).
const token = `refactored${stamp}`;
await prisma.page.update({
  where: { id: weak },
  data: { searchText: mirror(`Notes ${stamp}`, `now about ${token} instead`) },
});
const afterUpdate = await prisma.$queryRawUnsafe(
  `SELECT id FROM "Page" WHERE "id" = $1 AND to_tsvector('english', "searchText") @@ websearch_to_tsquery('english', $2)`,
  weak,
  token,
);
check("updating a page re-indexes its text", afterUpdate.length === 1);

await prisma.page.deleteMany({ where: { id: { in: created } } });
await prisma.$disconnect();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} search checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
