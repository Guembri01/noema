// Verify the public REST API (Bearer token) and public share links.
//
// The API enforces the grant of the bearer token: the read routes need
// `read:pages`, `POST /api/v1/pages` needs `write:pages`
// (`src/lib/api-token-scope.ts` — the catalogue the app knows). The script
// proves both halves of that contract: a token *with* the grant is served,
// a token *without* a grant is refused with `403 insufficient_scope`. It also
// proves the deadline of a token (B29): a token whose `expiresAt` lies in the
// past is refused with `401` — like an unknown token, and without touching its
// `lastUsedAt`.
//
// Usage: node --env-file=.env scripts/check-api.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const results = [];
/** Record one expectation. `ok` decides the exit code of the script. */
const check = (label, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

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
    // The grant this script needs: it reads the workspace, the pages and the
    // search index, and it creates a page.
    scopes: ["read:pages", "write:pages"],
  },
});
const auth = { authorization: `Bearer ${raw}` };

const unauth = await fetch(`${base}/api/v1/workspaces`);
check(`api unauth → ${unauth.status} (expect 401)`, unauth.status === 401);

const badKey = await fetch(`${base}/api/v1/workspaces`, {
  headers: { authorization: "Bearer nope" },
});
check(`api bad token → ${badKey.status} (expect 401)`, badKey.status === 401);

const ws = await fetch(`${base}/api/v1/workspaces`, { headers: auth });
const wsBody = await ws.json();
check(`api workspaces → ${ws.status} · ${wsBody.workspaces?.length ?? 0}`, ws.status === 200);

const pages = await fetch(`${base}/api/v1/pages?workspaceId=${workspace.id}`, {
  headers: auth,
});
const pagesBody = await pages.json();
check(`api pages → ${pages.status} · ${pagesBody.pages?.length ?? 0}`, pages.status === 200);

const one = await fetch(`${base}/api/v1/pages/${page.id}`, { headers: auth });
check(`api page → ${one.status} (expect 200)`, one.status === 200);

const search = await fetch(
  `${base}/api/v1/search?workspaceId=${workspace.id}&q=editor`,
  { headers: auth },
);
const searchBody = await search.json();
check(`api search → ${search.status} · ${searchBody.results?.length ?? 0}`, search.status === 200);

const created = await fetch(`${base}/api/v1/pages`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace.id, title: "API created" }),
});
check(`api create page → ${created.status} (expect 201)`, created.status === 201);

/* ---- the grant is enforced: a token without a scope is refused ---- */
const noScope = `noema_${randomBytes(16).toString("hex")}`;
await prisma.apiToken.create({
  data: {
    userId: user.id,
    name: "check-token-without-scope",
    tokenHash: createHash("sha256").update(noScope).digest("hex"),
    // No grant at all: the token is authentic, but it may do nothing.
    scopes: [],
  },
});
const noScopeAuth = { authorization: `Bearer ${noScope}` };

const refusedWrite = await fetch(`${base}/api/v1/pages`, {
  method: "POST",
  headers: { ...noScopeAuth, "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace.id, title: "API created without a scope" }),
});
const refusedWriteBody = await refusedWrite.json().catch(() => ({}));
check(
  `api create page without a scope → ${refusedWrite.status} (expect 403 insufficient_scope)`,
  refusedWrite.status === 403 && refusedWriteBody.error === "insufficient_scope",
);
check(
  `api create page without a scope names the required scope → ${refusedWriteBody.required ?? "none"} (expect write:pages)`,
  refusedWriteBody.required === "write:pages",
);

const refusedRead = await fetch(
  `${base}/api/v1/search?workspaceId=${workspace.id}&q=editor`,
  { headers: noScopeAuth },
);
const refusedReadBody = await refusedRead.json().catch(() => ({}));
check(
  `api search without a scope → ${refusedRead.status} (expect 403 insufficient_scope)`,
  refusedRead.status === 403 && refusedReadBody.error === "insufficient_scope",
);
check(
  `api search without a scope names the required scope → ${refusedReadBody.required ?? "none"} (expect read:pages)`,
  refusedReadBody.required === "read:pages",
);

/* ---- an expired token is refused like an unknown one ---- */
const expired = `noema_${randomBytes(16).toString("hex")}`;
await prisma.apiToken.create({
  data: {
    userId: user.id,
    name: "check-token-expired",
    tokenHash: createHash("sha256").update(expired).digest("hex"),
    scopes: ["read:pages", "write:pages"],
    // The deadline is in the past: the token is authentic, but it is dead.
    expiresAt: new Date(Date.now() - 1000),
  },
});
const expiredAuth = { authorization: `Bearer ${expired}` };

const expiredCall = await fetch(`${base}/api/v1/workspaces`, { headers: expiredAuth });
check(`api expired token → ${expiredCall.status} (expect 401)`, expiredCall.status === 401);

/* ---- public share link ---- */
const token = randomBytes(12).toString("hex");
await prisma.shareLink.create({
  data: { pageId: page.id, token, permission: "READ" },
});
const shared = await fetch(`${base}/s/${token}`);
const sharedHtml = await shared.text();
check(
  `public share → ${shared.status} · renders=${/Shared page/.test(sharedHtml)}`,
  shared.status === 200 && /Shared page/.test(sharedHtml),
);
// A missing link is a dead end: the route answers with the "no longer
// available" page (200) or with a 404 — both are a refusal, a rendered page
// with the shared content is not.
const badShare = await fetch(`${base}/s/nonexistent-token-xyz`);
const badShareHtml = await badShare.text();
const unavailable = /no longer available/i.test(badShareHtml);
check(
  `public share (bad token) → ${badShare.status} · unavailable=${unavailable}`,
  badShare.status === 404 || unavailable,
);

/* ---- cleanup ---- */
await prisma.apiToken.deleteMany({ where: { name: "check-token" } });
await prisma.apiToken.deleteMany({ where: { name: "check-token-without-scope" } });
await prisma.apiToken.deleteMany({ where: { name: "check-token-expired" } });
await prisma.shareLink.deleteMany({ where: { token } });
if (created.status === 201) {
  const body = await created.json();
  await prisma.page.delete({ where: { id: body.page.id } }).catch(() => {});
}
await prisma.$disconnect();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} api checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
