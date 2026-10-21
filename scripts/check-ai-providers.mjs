// Verifies BOTH configured providers directly, then exercises the app's
// transcription route with a generated audio file.
//
// Usage: node --env-file=.env scripts/check-ai-providers.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const PROOFREAD_INPUT =
  "teh quick brown fox jumps over teh lazy dog. it were a vary nise day and we was happy.";

const providers = [
  {
    name: "DeepSeek",
    baseUrl: process.env.AI_BASE_URL ?? "https://api.deepseek.com",
    key: process.env.AI_API_KEY ?? "",
    model: process.env.AI_MODEL ?? "deepseek-chat",
  },
  {
    name: "OpenAI",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    key: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  },
].filter((provider) => provider.key);

if (providers.length === 0) {
  console.error("No provider keys configured (AI_API_KEY / OPENAI_API_KEY).");
  process.exit(1);
}

/**
 * OpenCode Go, when it is the configured provider.
 *
 * Go publishes its catalogue under a path of its own — the chat endpoint's
 * path answers 404 — and it asks every client to identify itself and to name
 * the session it belongs to.
 */
const isOpenCodeGo = (baseUrl) => {
  try {
    return new URL(baseUrl).hostname === "opencode.ai";
  } catch {
    return false;
  }
};

/** The URL the provider publishes its catalogue under. */
const catalogueUrl = (baseUrl) =>
  isOpenCodeGo(baseUrl)
    ? "https://opencode.ai/inference/go/v1/models"
    : `${baseUrl.replace(/\/$/, "")}/models`;

/** The headers the provider expects from this client. */
const providerHeaders = (provider) => ({
  authorization: `Bearer ${provider.key}`,
  ...(isOpenCodeGo(provider.baseUrl)
    ? {
        "user-agent": "noema-check-ai-providers/1.0",
        "x-opencode-session": "noema:deployment:check-ai-providers",
      }
    : {}),
});

for (const provider of providers) {
  let modelsOk = false;
  let modelCount = 0;
  try {
    const response = await fetch(catalogueUrl(provider.baseUrl), {
      headers: providerHeaders(provider),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    modelCount = Array.isArray(body?.data) ? body.data.length : 0;
    modelsOk = response.ok;
  } catch {
    modelsOk = false;
  }
  check(`${provider.name}: key is valid (GET /models)`, modelsOk, `${modelCount} models`);

  let text = "";
  let ms = 0;
  try {
    const started = Date.now();
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        ...providerHeaders(provider),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "system",
            content:
              "You are a precise writing assistant. Reply with the corrected text only.",
          },
          { role: "user", content: `Proofread the text below, fixing spelling and grammar.\n\n${PROOFREAD_INPUT}` },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json().catch(() => null);
    ms = Date.now() - started;
    text = (body?.choices?.[0]?.message?.content ?? "").trim();
    if (!response.ok) text = `ERROR ${response.status} ${JSON.stringify(body).slice(0, 120)}`;
  } catch (error) {
    text = `ERROR ${String(error).slice(0, 120)}`;
  }

  check(
    `${provider.name}: chat completion answers (${provider.model})`,
    /the quick brown fox/i.test(text) && /(was|were) a very nice day/i.test(text),
    `${ms} ms · "${text.replace(/\s+/g, " ").slice(0, 70)}"`,
  );
}

// --- Transcription through the app (needs AI_TRANSCRIBE_API_KEY) ----------
const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

/** 1s 8 kHz mono WAV with a 440 Hz tone — valid audio for the API. */
function toneWav() {
  const sampleRate = 8000;
  const seconds = 1;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3 * 32767;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const form = new FormData();
form.append("file", new Blob([toneWav()], { type: "audio/wav" }), "tone.wav");
const transcription = await fetch(`${base}/api/ai/transcribe`, {
  method: "POST",
  headers: { cookie: `noema_session=${session}` },
  body: form,
});
const transcriptionBody = await transcription.json().catch(() => null);
check(
  "transcription route reaches the speech-to-text provider",
  transcription.status === 200 && typeof transcriptionBody?.text === "string",
  `status ${transcription.status}${transcriptionBody?.error ? ` · ${String(transcriptionBody.error).slice(0, 80)}` : ""}`,
);

await prisma.$disconnect();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed across ${providers.length} provider(s)`);
process.exit(passed === results.length ? 0 : 1);
