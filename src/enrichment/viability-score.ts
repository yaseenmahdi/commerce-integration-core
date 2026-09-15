import { getConfig } from "../config.js";
import { logger } from "../logger.js";

export type ViabilityScores = {
  viralVideoPotential: number;
  problemSolvingValue: number;
  combined: number;
  rationale: string;
  source: "gemini" | "heuristic";
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function combinedScore(viral: number, problem: number): number {
  return Math.round((viral * 0.6 + problem * 0.4) * 10) / 10;
}

const DEMO_WORDS = /\b(peel|clip|organize|organiser|leak|pet|kitchen|travel|magnetic|fold|gadget|hack|lint|garlic|sock|spill|clutter|holder|stand|grip)\b/i;
const PROBLEM_WORDS = /\b(leak|mess|tangle|clutter|shed|hair|odor|odour|spill|wrinkle|static|fog|scratch|slip|lost|tangled)\b/i;

/** Deterministic fallback so research still ranks SKUs when Gemini is off. */
export function heuristicViabilityScores(title: string, description: string): ViabilityScores {
  const text = `${title} ${description}`;
  let viral = 4;
  let problem = 4;
  if (DEMO_WORDS.test(text)) viral += 3;
  if (PROBLEM_WORDS.test(text)) problem += 3;
  if (title.split(/\s+/).length <= 8) viral += 1;
  viral = clampScore(viral);
  problem = clampScore(problem);
  return {
    viralVideoPotential: viral,
    problemSolvingValue: problem,
    combined: combinedScore(viral, problem),
    rationale: "Heuristic demo/problem-word scorer (Gemini disabled or unavailable).",
    source: "heuristic",
  };
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/\{[\s\S]*\}/);
  if (!fenced) throw new Error("Gemini response did not contain JSON");
  return JSON.parse(fenced[0]) as unknown;
}

/**
 * Rule 5: score title + description 1–10 on viral video potential and problem-solving value.
 * Uses Gemini Flash when LLM_PROVIDER=gemini and GEMINI_API_KEY is set.
 */
export async function scoreProductViability(title: string, description: string): Promise<ViabilityScores> {
  const config = getConfig();
  if (config.LLM_PROVIDER !== "gemini" || !config.GEMINI_API_KEY) {
    return heuristicViabilityScores(title, description);
  }

  const prompt = [
    "You score US TikTok Shop / Shopify dropship products.",
    "Return ONLY JSON: {\"viralVideoPotential\":1-10,\"problemSolvingValue\":1-10,\"rationale\":\"one sentence\"}.",
    "viralVideoPotential = how easily a 15s demo video could go viral (visual, satisfying, unexpected).",
    "problemSolvingValue = how clearly it solves a daily annoyance.",
    `Title: ${title.slice(0, 200)}`,
    `Description: ${description.slice(0, 800)}`,
  ].join("\n");

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent`,
  );
  url.searchParams.set("key", config.GEMINI_API_KEY);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { endpoint: "gemini:generateContent", status: res.status, body: body.slice(0, 300) },
        "Gemini viability score failed — using heuristic",
      );
      return heuristicViabilityScores(title, description);
    }
    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = extractJsonObject(text) as {
      viralVideoPotential?: number;
      problemSolvingValue?: number;
      rationale?: string;
    };
    const viral = clampScore(Number(parsed.viralVideoPotential));
    const problem = clampScore(Number(parsed.problemSolvingValue));
    return {
      viralVideoPotential: viral,
      problemSolvingValue: problem,
      combined: combinedScore(viral, problem),
      rationale: (parsed.rationale ?? "").slice(0, 280),
      source: "gemini",
    };
  } catch (err) {
    logger.warn(
      { err, endpoint: "gemini:generateContent", timestamp: new Date().toISOString() },
      "Gemini viability score threw — using heuristic",
    );
    return heuristicViabilityScores(title, description);
  }
}
