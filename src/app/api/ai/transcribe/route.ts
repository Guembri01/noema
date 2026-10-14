import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

const BASE_URL = process.env.AI_TRANSCRIBE_BASE_URL ?? "https://api.openai.com/v1";
const MODEL = process.env.AI_TRANSCRIBE_MODEL ?? "whisper-1";
const KEY =
  process.env.AI_TRANSCRIBE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";

/** Speech-to-text via an OpenAI-compatible transcription endpoint. */
export async function POST(request: Request) {
  const limited = rateLimit(request, "transcribe", 10, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!KEY) {
    // Kept separate from AI_API_KEY on purpose: chat providers (DeepSeek,
    // Groq, …) do not all expose /audio/transcriptions.
    return NextResponse.json(
      {
        error:
          "Transcription is not configured. Set AI_TRANSCRIBE_API_KEY (speech-to-text provider).",
      },
      { status: 503 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const body = new FormData();
  body.append("file", file);
  body.append("model", MODEL);

  try {
    const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json(
        { error: `Transcription failed (${response.status}): ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const data = (await response.json()) as { text?: string };
    return NextResponse.json({ text: data.text ?? "" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Transcription failed" },
      { status: 502 },
    );
  }
}
