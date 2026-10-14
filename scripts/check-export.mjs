// Check export endpoints, the inbox route and the default theme.
// Usage: node --env-file=.env scripts/check-export.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const page = await prisma.page.findFirst({ where: { workspaceId: workspace.id, type: "PAGE" } });
const database = await prisma.page.findFirst({ where: { workspaceId: workspace.id, type: "DATABASE" } });

const token = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const cookie = { cookie: `noema_session=${token}` };

const md = await fetch(`${base}/api/export/page/${page.id}?format=md`, { headers: cookie });
const mdBody = await md.text();
console.log(`export page md → ${md.status} · type=${md.headers.get("content-type")} · ${mdBody.split("\n").length} lines`);

const json = await fetch(`${base}/api/export/page/${page.id}?format=json`, { headers: cookie });
console.log(`export page json → ${json.status} · type=${json.headers.get("content-type")}`);

const csv = await fetch(`${base}/api/export/database/${database.id}`, { headers: cookie });
const csvBody = await csv.text();
console.log(`export database csv → ${csv.status} · type=${csv.headers.get("content-type")} · ${csvBody.split("\r\n").length - 1} rows`);

const html = await fetch(`${base}/api/export/page/${page.id}?format=html`, { headers: cookie });
console.log(`export page html → ${html.status} · type=${html.headers.get("content-type")}`);

const zip = await fetch(`${base}/api/export/workspace/${workspace.slug}`, { headers: cookie });
const zipBytes = (await zip.arrayBuffer()).byteLength;
console.log(`export workspace zip → ${zip.status} · type=${zip.headers.get("content-type")} · ${zipBytes} bytes`);

const pdf = await fetch(`${base}/api/export/page/${page.id}?format=pdf`, { headers: cookie });
const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
console.log(
  `export page pdf → ${pdf.status} · type=${pdf.headers.get("content-type")} · %PDF=${pdfBuffer.subarray(0, 4).toString() === "%PDF"} · ${pdfBuffer.length} bytes`,
);

// RTL: switch the demo user to Arabic and confirm the document direction flips.
await prisma.user.update({ where: { id: user.id }, data: { locale: "ar" } });
const rtl = await fetch(`${base}/w/${workspace.slug}`, { headers: cookie });
const rtlHtml = await rtl.text();
console.log(`i18n rtl → ${rtl.status} · dir=rtl:${/dir="rtl"/.test(rtlHtml)} · lang=ar:${/lang="ar"/.test(rtlHtml)}`);
await prisma.user.update({ where: { id: user.id }, data: { locale: "en" } });

const inbox = await fetch(`${base}/w/${workspace.slug}/inbox`, { headers: cookie });
console.log(`inbox page → ${inbox.status}`);

const landing = await fetch(`${base}/`);
const landingHtml = await landing.text();
console.log(`landing → ${landing.status} · white default (dark class absent on first paint)=${!/class="dark"/.test(landingHtml)}`);

const ai = await fetch(`${base}/api/ai`, {
  method: "POST",
  headers: { ...cookie, "content-type": "application/json" },
  body: JSON.stringify({ prompt: "hello" }),
});
console.log(`ai → ${ai.status} (${ai.status === 503 ? "unconfigured" : "configured"})`);

const settings = await fetch(`${base}/w/${workspace.slug}/settings`, { headers: cookie });
const settingsHtml = await settings.text();
console.log(
  `settings page → ${settings.status} · two-factor:${/Two-factor authentication/.test(settingsHtml)} · api tokens:${/API tokens/.test(settingsHtml)} · webhooks:${/Webhooks/.test(settingsHtml)} · teamspaces:${/Teamspaces/.test(settingsHtml)} · oauth apps:${/OAuth apps/.test(settingsHtml)}`,
);

const transcribe = await fetch(`${base}/api/ai/transcribe`, {
  method: "POST",
  headers: cookie,
  body: new FormData(),
});
console.log(`ai transcription (unconfigured) → ${transcribe.status} (expect 503)`);

const notionImport = await fetch(`${base}/api/import/notion`, {
  method: "POST",
  headers: { ...cookie, "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace.id, token: "", pageId: "" }),
});
console.log(`notion import (missing token) → ${notionImport.status} (expect 400)`);

const sidebarPage = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, parentId: null },
  select: { id: true },
});
const sidebarHtml = await fetch(`${base}/w/${workspace.slug}/${sidebarPage.id}`, { headers: cookie }).then((r) => r.text());
console.log(
  `sidebar imports → notion-api:${/Import from Notion \(API\)/.test(sidebarHtml)} · transcribe:${/Transcribe audio/.test(sidebarHtml)}`,
);

await prisma.$disconnect();
