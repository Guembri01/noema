import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { logProviderFailure, providerFailure, transportFailure } from "@/lib/ai-provider";

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
      // The provider's body is untrusted: it may echo the API key back. The
      // failure is reduced to its status plus a stable code, and only that
      // class reaches the log.
      const failure = providerFailure(response.status, text, KEY);
      logProviderFailure(failure);
      return NextResponse.json(
        { error: `Transcription failed (${response.status}): ${failure.code}` },
        { status: 502 },
      );
    }
    const data = (await response.json()) as { text?: string };
    return NextResponse.json({ text: data.text ?? "" });
  } catch {
    // A transport failure: the runtime's message can carry the request header,
    // and the header carries the workspace's key. It is never forwarded — not
    // even scrubbed, since a scrubber only knows credential *shapes* and the
    // tail of a key with an interior newline is no shape at all. The class
    // goes to the client, the class goes to the log.
    return NextResponse.json({ error: transportFailure() }, { status: 502 });
  }
}
