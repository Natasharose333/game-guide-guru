import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const CoachInput = z.object({
  /** data URL: data:image/jpeg;base64,... */
  frame: z.string().min(32),
  /** last known game name, helps stability */
  knownGame: z.string().nullable(),
  /** short rolling memory of prior advice */
  recent: z.array(z.string()),
});

export type CoachResult = {
  game: string;
  confidence: number;
  objective: string;
  action: string;
  danger: string | null;
};

const SYSTEM = `You are a real-time video game coach watching a single screenshot of a live game.
Identify the game from HUD, art style, UI and level design. If you truly cannot tell, use "Unknown".
Then give guidance to survive and reach the next goal.

Reply ONLY with compact JSON, no markdown:
{"game":string,"confidence":number 0-1,"objective":short current quest/objective (max 12 words),"action":ONE imperative next action (max 10 words),"danger":immediate threat or null}
Be decisive and terse. Never explain. Never repeat the previous action verbatim if the scene changed.`;

export const coachFrame = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CoachInput.parse(input))
  .handler(async ({ data }): Promise<CoachResult> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const context = [
      data.knownGame ? `Previously identified game: ${data.knownGame}.` : null,
      data.recent.length ? `Recent advice given: ${data.recent.join(" | ")}.` : null,
    ]
      .filter(Boolean)
      .join(" ");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "google/gemini-3.7-flash",
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${context} What game is this and what should I do next?`,
              },
              { type: "image_url", image_url: { url: data.frame } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI_${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        game: data.knownGame ?? "Unknown",
        confidence: 0,
        objective: "Could not read the scene",
        action: raw.slice(0, 80) || "Try again",
        danger: null,
      };
    }
    const parsed = JSON.parse(match[0]) as Partial<CoachResult>;
    return {
      game: parsed.game || data.knownGame || "Unknown",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      objective: parsed.objective || "—",
      action: parsed.action || "Keep going",
      danger: parsed.danger || null,
    };
  });
