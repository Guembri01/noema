import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const u = await p.user.update({
  where: { email: "demo@noema.local" },
  data: { locale: "en" },
});
console.log("locale reset ->", u.locale);
await p.$disconnect();
