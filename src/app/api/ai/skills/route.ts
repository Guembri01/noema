import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { aiSkill, type AiSkillId } from "@/lib/ai-skills";
import { AI_NOT_CONFIGURED, chatComplete, resolveAiConfig } from "@/lib/ai-provider";

export const runtime = "nodejs";

const SYSTEM =
  "You are a precise writing assistant embedded in a notes app. Reply with the transformed text only — no preamble, no quotes, no explanation.";

/**
 * Run one of the editor's AI skills over a text selection. The prompt wording
 * lives server-side (`src/lib/ai-skills.ts`) so the toolbar, the block menu and
 * any future automation all behave identically.
 *
 * Body: { skillId, text }
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "ai-skills", 30, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { skillId?: string; text?: string; workspaceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const skill = aiSkill(body.skillId as AiSkillId);
  if (!skill) return NextResponse.json({ error: "Unknown skill." }, { status: 400 });

  const text = (body.text ?? "").trim().slice(0, 8000);
  if (!text) return NextResponse.json({ error: "text is required." }, { status: 400 });

  const config = await resolveAiConfig(body.workspaceId);
  if (!config) {
    return NextResponse.json({ error: AI_NOT_CONFIGURED }, { status: 503 });
  }

  const result = await chatComplete(
    {
      system: SYSTEM,
      user: skill.prompt(text),
      temperature: skill.replacesSelection ? 0.2 : 0.5,
    },
    config,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    skill: skill.id,
    replacesSelection: skill.replacesSelection,
    text: result.text,
  });
}
