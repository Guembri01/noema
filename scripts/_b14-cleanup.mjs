import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const a = await p.page.deleteMany({ where: { title: { startsWith: "paginated" } } });
const b = await p.page.deleteMany({ where: { title: { startsWith: "trashed page" }, deletedAt: { not: null } } });
const c = await p.comment.deleteMany({ where: { body: { startsWith: "typo target" } } });
const d = await p.comment.deleteMany({ where: { body: { startsWith: "fixed body" } } });
console.log("deleted pages(junk):", a.count, "pages(trashed):", b.count, "comments(typo):", c.count, "comments(fixed):", d.count);
await p.$disconnect();
