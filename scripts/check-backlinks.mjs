// Authenticated checks for mentions (chip) and backlinks (panel).
// Usage: node --env-file=.env scripts/check-backlinks.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });

const token = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

const fetchPage = async (title) => {
  const page = await prisma.page.findFirst({
    where: { workspaceId: workspace.id, title },
  });
  if (!page) return { title, status: 0, html: "" };
  const response = await fetch(`${base}/w/${workspace.slug}/${page.id}`, {
    headers: { cookie: `noema_session=${token}` },
  });
  return { title, status: response.status, html: await response.text() };
};

const target = await fetchPage("Getting started");
const source = await fetchPage("Editor tips");

console.log(`Getting started → ${target.status} · panel=${/Linked references/.test(target.html)}`);
console.log(`Editor tips     → ${source.status} · mention chip=${/noema-mention/.test(source.html)}`);

await prisma.$disconnect();
