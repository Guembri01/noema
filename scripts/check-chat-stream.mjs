// Smoke: the chat answer streams token by token and is persisted once.
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = "http://localhost:3200";
const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
const thread = await prisma.chatThread.create({
  data: { workspaceId: workspace.id, createdById: user.id, title: "stream smoke" },
  select: { id: true },
});
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

const started = Date.now();
const response = await fetch(`${base}/api/chat/stream`, {
  method: "POST",
  headers: { cookie: `noema_session=${session}`, "content-type": "application/json" },
  body: JSON.stringify({ threadId: thread.id, body: "List my projects in one short table." }),
});

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

check("stream responds 200 with a text stream", response.ok && (response.headers.get("content-type") ?? "").includes("text/plain"));
const reader = response.body.getReader();
const decoder = new TextDecoder();
let text = "";
let chunks = 0;
let firstChunkAt = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks += 1;
  if (chunks === 1) firstChunkAt = Date.now() - started;
  text += decoder.decode(value, { stream: true });
}
const total = Date.now() - started;

check("body carried content", text.trim().length > 20, `${text.trim().length} chars`);
check("arrived in multiple chunks (not one blob)", chunks > 1, `${chunks} chunks`);
check("first chunk arrived before the answer finished", firstChunkAt > 0 && firstChunkAt < total, `${firstChunkAt}ms vs ${total}ms`);
check("answer is structured Markdown", /(\n[-*] |\n\||###)/.test(text), JSON.stringify(text.slice(0, 60)));

const messages = await prisma.chatMessage.findMany({
  where: { threadId: thread.id },
  orderBy: { createdAt: "asc" },
  select: { role: true, body: true, meta: true },
});
check("user message + one assistant message persisted", messages.length === 2 && messages[1].role === "assistant", `${messages.length} rows`);
check("assistant row matches the streamed text", messages[1].body.startsWith(text.trim().slice(0, 40)));
check("assistant meta records the model", Boolean((messages[1].meta ?? {}).model));


await prisma.chatThread.delete({ where: { id: thread.id } });
await prisma.$disconnect();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} streaming checks passed (answer took ${total}ms)`);
process.exit(passed === results.length ? 0 : 1);
