// Verifies the Notion API importer end-to-end against a mock Notion server.
// Requires the app to be started with:
//   $env:NOTION_API_BASE="http://localhost:4322/v1"
// Usage: node --env-file=.env scripts/check-notion.mjs [baseUrl]
import http from "node:http";
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const NOTION_PORT = 4322;
const NOTION_BASE = `http://localhost:${NOTION_PORT}/v1`;
const prisma = new PrismaClient();

const ROOT_ID = "11111111-1111-1111-1111-111111111111";
const CHILD_ID = "22222222-2222-2222-2222-222222222222";

const page = (title) => ({
  object: "page",
  properties: { Name: { type: "title", title: [{ plain_text: title }] } },
});
const rich = (text) => [{ plain_text: text }];

const blocks = {
  [ROOT_ID]: [
    { id: "b1", type: "paragraph", paragraph: { rich_text: rich("Intro line") } },
    { id: "b2", type: "heading_2", heading_2: { rich_text: rich("Goals") } },
    { id: "b3", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich("First") } },
    { id: "b4", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich("Second") } },
    { id: "b5", type: "to_do", to_do: { rich_text: rich("Ship it"), checked: true } },
    { id: CHILD_ID, type: "child_page", child_page: { title: "Details" }, has_children: true },
  ],
  [CHILD_ID]: [
    { id: "c1", type: "paragraph", paragraph: { rich_text: rich("Nested content") } },
  ],
};

const notion = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${NOTION_PORT}`);
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const token = req.headers.authorization ?? "";
  if (token !== "Bearer secret_test_token") return json(401, { message: "unauthorized" });

  const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(url.pathname);
  if (pageMatch) {
    if (pageMatch[1] === ROOT_ID) return json(200, page("Roadmap"));
    if (pageMatch[1] === CHILD_ID) return json(200, page("Details"));
    return json(404, { message: "not found" });
  }

  const childMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(url.pathname);
  if (childMatch) {
    const results = blocks[childMatch[1]];
    if (!results) return json(404, { message: "not found" });
    return json(200, { results, has_more: false, next_cursor: null });
  }
  return json(404, { message: "not found" });
});

await new Promise((resolve) => notion.listen(NOTION_PORT, resolve));
console.log(`mock Notion listening on ${NOTION_BASE}`);

const results = [];
const check = (label, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const headers = { cookie: `noema_session=${session}`, "content-type": "application/json" };

// The workspace's own naming convention (name/slug) must not clash with the mock.
const clean = () =>
  prisma.page.deleteMany({
    where: { workspaceId: workspace.id, createdById: user.id, icon: "📥" },
  });
await clean();

// Unauthenticated + bad-token + missing-id paths.
const anon = await fetch(`${base}/api/import/notion`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
check("notion import requires authentication", anon.status === 401);

const badToken = await fetch(`${base}/api/import/notion`, {
  method: "POST",
  headers,
  body: JSON.stringify({ workspaceId: workspace.id, token: "wrong", pageId: ROOT_ID }),
});
check("notion import surfaces a rejected token", badToken.status === 400 && /401/.test(await badToken.text()));

const noId = await fetch(`${base}/api/import/notion`, {
  method: "POST",
  headers,
  body: JSON.stringify({ workspaceId: workspace.id, token: "secret_test_token", pageId: "" }),
});
check("notion import requires a page id", noId.status === 400);

// Happy path: import the mocked page tree.
const imported = await fetch(`${base}/api/import/notion`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    workspaceId: workspace.id,
    token: "secret_test_token",
    pageId: `https://www.notion.so/Roadmap-${ROOT_ID.replace(/-/g, "")}`,
  }),
});
const body = await imported.json();
console.log(`      notion response: ${imported.status} ${JSON.stringify(body)}`);
check("notion import creates the page tree", imported.status === 200 && body.pages === 2);

const root = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, title: "Roadmap", icon: "📥" },
  select: { id: true, content: true },
});
const child = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, title: "Details", icon: "📥" },
  select: { id: true, parentId: true },
});
check("root page imported with its title", Boolean(root));
check("nested child page imported under the root", Boolean(child) && child.parentId === root?.id);

const doc = root?.content;
const types = doc?.content?.map((node) => node.type) ?? [];
check(
  "block types mapped (paragraph, heading, lists, task)",
  types.includes("paragraph") &&
    types.includes("heading") &&
    types.includes("bulletList") &&
    types.includes("taskList"),
);

await clean();
await prisma.$disconnect();
notion.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
