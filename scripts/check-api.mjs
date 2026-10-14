// Verify the public REST API (Bearer token) and public share links.
// Usage: node --env-file=.env scripts/check-api.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const page = await prisma.page.findFirst({ where: { workspaceId: workspace.id } });

/* ---- API token auth ---- */
const raw = `noema_${randomBytes(16).toString("hex")}`;
await prisma.apiToken.create({
  data: {
    userId: user.id,
    name: "check-token",
    tokenHash: createHash("sha256").update(raw).digest("hex"),
  },
});
const auth = { authorization: `Bearer ${raw}` };

const unauth = await fetch(`${base}/api/v1/workspaces`);
console.log(`api unauth → ${unauth.status} (expect 401)`);

const badKey = await fetch(`${base}/api/v1/workspaces`, {
  headers: { authorization: "Bearer nope" },
});
console.log(`api bad token → ${badKey.status} (expect 401)`);

const ws = await fetch(`${base}/api/v1/workspaces`, { headers: auth });
const wsBody = await ws.json();
console.log(`api workspaces → ${ws.status} · ${wsBody.workspaces?.length ?? 0}`);

const pages = await fetch(`${base}/api/v1/pages?workspaceId=${workspace.id}`, {
  headers: auth,
});
const pagesBody = await pages.json();
console.log(`api pages → ${pages.status} · ${pagesBody.pages?.length ?? 0}`);

const one = await fetch(`${base}/api/v1/pages/${page.id}`, { headers: auth });
console.log(`api page → ${one.status}`);

const search = await fetch(
  `${base}/api/v1/search?workspaceId=${workspace.id}&q=editor`,
  { headers: auth },
);
const searchBody = await search.json();
console.log(`api search → ${search.status} · ${searchBody.results?.length ?? 0}`);

const created = await fetch(`${base}/api/v1/pages`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace.id, title: "API created" }),
});
console.log(`api create page → ${created.status} (expect 201)`);

/* ---- public share link ---- */
const token = randomBytes(12).toString("hex");
await prisma.shareLink.create({
  data: { pageId: page.id, token, permission: "READ" },
});
const shared = await fetch(`${base}/s/${token}`);
const sharedHtml = await shared.text();
console.log(
  `public share → ${shared.status} · renders=${/Shared page/.test(sharedHtml)}`,
);
const badShare = await fetch(`${base}/s/nonexistent-token-xyz`);
console.log(`public share (bad token) → ${badShare.status} (expect 404)`);

/* ---- cleanup ---- */
await prisma.apiToken.deleteMany({ where: { name: "check-token" } });
await prisma.shareLink.deleteMany({ where: { token } });
if (created.status === 201) {
  const body = await created.json();
  await prisma.page.delete({ where: { id: body.page.id } }).catch(() => {});
}
await prisma.$disconnect();
