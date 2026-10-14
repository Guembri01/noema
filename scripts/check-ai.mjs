// End-to-end AI checks against the configured provider (AI_API_KEY / AI_BASE_URL
// / AI_MODEL). Exercises every AI surface the app ships:
//   /api/ai          ask · grounded ask · summarize · autofill
//   /api/ai/skills   all editor skills (proofread, improve, reformat, …)
//   /api/ai/transcribe provider separation
//
// Usage: node --env-file=.env scripts/check-ai.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

// Node strips the types of the shared skill definitions (Node 22.18+/24).
let AI_SKILLS;
try {
  ({ AI_SKILLS } = await import("../src/lib/ai-skills.ts"));
} catch {
  AI_SKILLS = [
    "improve",
    "proofread",
    "reformat",
    "shorten",
    "explain",
    "summarize",
    "translate",
  ].map((id) => ({ id, label: id, replacesSelection: id !== "explain" && id !== "summarize" }));
}

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const auth = { cookie: `noema_session=${session}` };
const json = { ...auth, "content-type": "application/json" };

const post = (path, body, headers = json) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Models are stochastic: for assertions about *content*, run twice before
 * failing. The property under test ("the skill actually transforms the text")
 * is still verified — we just tolerate one odd sample.
 */
const checkContent = async (label, probe) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [ok, detail] = await probe();
    if (ok) {
      check(label, true, detail);
      return;
    }
    if (attempt === 0) await sleep(800);
    else check(label, false, detail);
  }
};

const preview = (text) =>
  `"${String(text).replace(/\s+/g, " ").slice(0, 70)}${String(text).length > 70 ? "…" : ""}"`;

if (!process.env.AI_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("No AI_API_KEY configured — set it in .env before running this suite.");
  process.exit(1);
}

console.log(
  `provider: ${process.env.AI_BASE_URL ?? "https://api.openai.com/v1"} · model: ${process.env.AI_MODEL ?? "gpt-4o-mini"}\n`,
);

// --- Auth & validation ---------------------------------------------------
check("/api/ai requires authentication", (await post("/api/ai", { prompt: "hi" }, { "content-type": "application/json" })).status === 401);
check("/api/ai/skills requires authentication", (await post("/api/ai/skills", { skillId: "proofread", text: "hi" }, { "content-type": "application/json" })).status === 401);

const badJson = await fetch(`${base}/api/ai`, { method: "POST", headers: json, body: "{" });
check("/api/ai rejects an invalid body", badJson.status === 400);

const noPrompt = await post("/api/ai", {});
check("/api/ai ask requires a prompt", noPrompt.status === 400);

const noContext = await post("/api/ai", { mode: "summarize" });
check("/api/ai summarize requires context", noContext.status === 400);

const unknownSkill = await post("/api/ai/skills", { skillId: "does-not-exist", text: "hi" });
check("/api/ai/skills rejects an unknown skill", unknownSkill.status === 400);

const emptySkillText = await post("/api/ai/skills", { skillId: "proofread", text: "   " });
check("/api/ai/skills rejects empty text", emptySkillText.status === 400);

// --- Ask -----------------------------------------------------------------
const ask = await post("/api/ai", { prompt: "Reply with exactly this word and nothing else: PONG" });
const askBody = await ask.json();
check(
  "ask returns a completion",
  ask.status === 200 && typeof askBody.text === "string" && askBody.text.trim().length > 0,
  preview(askBody.text ?? askBody.error),
);
check("ask follows the instruction", /PONG/i.test(askBody.text ?? ""));

// --- Grounded ask (workspace search) ------------------------------------
// Deterministic proof that workspace search feeds the model: plant a page,
// ask about it, then remove it.
const marker = `Zebra Quokka ${Date.now()}`;
const planted = await prisma.page.create({
  data: {
    workspaceId: workspace.id,
    title: marker,
    icon: "🧪",
    createdById: user.id,
    position: 999999,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "The launch code for the quokka programme is TANGERINE-42." }],
        },
      ],
    },
  },
  select: { id: true },
});

const grounded = await post("/api/ai", {
  prompt: `${marker}: what is the launch code mentioned in the context? Reply with the code only.`,
  workspaceId: workspace.id,
});
const groundedBody = await grounded.json();
check(
  "grounded ask answers from workspace content",
  grounded.status === 200 && groundedBody.text?.toUpperCase().includes("TANGERINE-42"),
  preview(groundedBody.text ?? groundedBody.error),
);

await prisma.page.deleteMany({ where: { id: planted.id } });

// --- Summarize -----------------------------------------------------------
const summary = await post("/api/ai", {
  mode: "summarize",
  context:
    "The editor supports heading, lists, tables and callouts. Databases add properties, views, filters and formulas. Sharing supports passwords and expiry. Webhooks are HMAC signed with retries.",
});
const summaryBody = await summary.json();
check(
  "summarize condenses the context",
  summary.status === 200 &&
    (summaryBody.text ?? "").length > 0 &&
    (summaryBody.text ?? "").length < 600,
  preview(summaryBody.text ?? summaryBody.error),
);

// --- Autofill ------------------------------------------------------------
const autofill = await post("/api/ai", {
  mode: "autofill",
  prompt: 'Classify this task into exactly one word, either High or Low priority: "Production outage".',
});
const autofillBody = await autofill.json();
const autofillText = (autofillBody.text ?? "").trim();
check(
  "autofill returns a single short value",
  autofill.status === 200 && autofillText.length > 0 && !autofillText.includes("\n"),
  preview(autofillText || autofillBody.error),
);

// --- Editor skills (the real prompts, server-side) -----------------------
const SAMPLE =
  "teh quick brown fox jumps over teh lazy dog. it were a vary nise day and we was happy.";
let skillFailures = 0;
for (const skill of AI_SKILLS) {
  const response = await post("/api/ai/skills", { skillId: skill.id, text: SAMPLE });
  const body = await response.json().catch(() => null);
  const ok =
    response.status === 200 &&
    typeof body?.text === "string" &&
    body.text.trim().length > 0 &&
    body.skill === skill.id &&
    body.replacesSelection === skill.replacesSelection;
  if (!ok) skillFailures += 1;
  check(`skill "${skill.id}" (${skill.label})`, ok, preview(body?.text ?? body?.error));
}

await checkContent("proofread actually fixes spelling", async () => {
  const response = await post("/api/ai/skills", { skillId: "proofread", text: SAMPLE });
  const text = ((await response.json()).text ?? "").toLowerCase();
  return [
    text.includes("the quick brown fox") && /(was|were) a very nice day/.test(text),
    preview(text),
  ];
});

await checkContent("make shorter produces shorter text", async () => {
  const response = await post("/api/ai/skills", {
    skillId: "shorten",
    text: "In order to be able to make a decision about the matter, we will need to have a meeting at some point in the near future.",
  });
  const text = ((await response.json()).text ?? "").trim();
  return [text.length > 0 && text.length < 120, preview(text)];
});

await checkContent("translate converts French to English", async () => {
  const response = await post("/api/ai/skills", {
    skillId: "translate",
    text: "Bonjour, comment allez-vous ?",
  });
  const text = ((await response.json()).text ?? "").toLowerCase();
  return [/hello|how are you/.test(text), preview(text)];
});

// --- Transcription separation -------------------------------------------
const transcribe = await fetch(`${base}/api/ai/transcribe`, { method: "POST", headers: auth, body: new FormData() });
const transcribeBody = await transcribe.json().catch(() => null);
// Transcription has its own provider config: without a transcribe key the route
// refuses with guidance, and with one it validates the request (no audio here).
const transcribeConfigured = Boolean(process.env.AI_TRANSCRIBE_API_KEY);
check(
  "transcription uses its own provider configuration",
  transcribeConfigured
    ? transcribe.status === 400 && /file is required/i.test(transcribeBody?.error ?? "")
    : transcribe.status === 503 && /AI_TRANSCRIBE_API_KEY/.test(transcribeBody?.error ?? ""),
  `${transcribeConfigured ? "configured" : "unconfigured"} · ${preview(transcribeBody?.error)}`,
);

await prisma.$disconnect();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed (${AI_SKILLS.length - skillFailures}/${AI_SKILLS.length} skills ok)`);
process.exit(passed === results.length ? 0 : 1);
