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
  /** set when the gateway refused the call (rate limit / credits) */
  error?: "rate_limited" | "no_credits" | "failed";
  game: string;
  confidence: number;
  location: string;
  stats: Array<{ label: string; value: string }>;
  objective: string;
  progress: string;
  steps: string[];
  action: string;
  danger: string | null;
};

const SYSTEM = `You are an expert speedrun-grade coach watching a single screenshot of a live console game.

Read the screen like a pro: identify the game from HUD, art style, UI and level design. Then READ THE HUD LITERALLY and report the player's actual numbers (health, shields, ammo/magazine, stamina, currency, level/XP, lives, timer, score, wave/round, objective markers, minimap position). Only report values you can actually see; never invent them.

Say WHERE the player is (area/level/zone/mission name if visible, otherwise describe it), how far along the current task appears to be, and the concrete ordered steps to finish the CURRENT required task so the player advances to the next one on the path to beating the game.

Reply ONLY with compact JSON, no markdown:
{"game":string,"confidence":number 0-1,"location":short area/level/mission name or description (max 10 words),"stats":[{"label":string,"value":string}] up to 6 HUD readings you can actually see,"objective":the current required task (max 14 words),"progress":how far along it is, e.g. "2/5 relics" or "boss at ~40% HP" (max 10 words),"steps":[2-4 short ordered steps to complete that task],"action":ONE imperative next action right now (max 10 words),"danger":immediate threat or null}

Be decisive and terse. Never narrate what the player is already doing — always say what to do NEXT. Never repeat the previous action verbatim if the scene changed.`;

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
                text: `${context} Read my stats and position, then tell me the exact next step to finish the current task.`,
              },
              { type: "image_url", image_url: { url: data.frame } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      await res.text().catch(() => "");
      return {
        error:
          res.status === 429 ? "rate_limited" : res.status === 402 ? "no_credits" : "failed",
        game: data.knownGame ?? "Unknown",
        confidence: 0,
        location: "—",
        stats: [],
        objective: "—",
        progress: "—",
        steps: [],
        action:
          res.status === 429
            ? "Busy — retrying shortly"
            : res.status === 402
              ? "Out of AI credits"
              : "Couldn't read that frame",
        danger: null,
      };
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
        location: "—",
        stats: [],
        objective: "Could not read the scene",
        progress: "—",
        steps: [],
        action: raw.slice(0, 80) || "Try again",
        danger: null,
      };
    }
    const parsed = JSON.parse(match[0]) as Partial<CoachResult>;
    return {
      game: parsed.game || data.knownGame || "Unknown",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      location: parsed.location || "—",
      stats: Array.isArray(parsed.stats)
        ? parsed.stats
            .filter((s) => s && typeof s.label === "string")
            .slice(0, 6)
            .map((s) => ({ label: String(s.label), value: String(s.value ?? "") }))
        : [],
      objective: parsed.objective || "—",
      progress: parsed.progress || "—",
      steps: Array.isArray(parsed.steps) ? parsed.steps.map(String).slice(0, 4) : [],
      action: parsed.action || "Keep going",
      danger: parsed.danger || null,
    };
  });

const SpeakInput = z.object({ text: z.string().min(1).max(600) });

/** Returns base64 mp3 for the given line. */
export const speakLine = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SpeakInput.parse(input))
  .handler(async ({ data }): Promise<{ audio: string | null }> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: data.text,
        voice: "alloy",
        response_format: "mp3",
        instructions: "Speak like a fast, confident esports coach. Urgent but clear.",
      }),
    });

    if (!res.ok) {
      // Rate limited / out of credits: let the client fall back to browser speech.
      await res.text().catch(() => "");
      return { audio: null };
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    return { audio: btoa(binary) };
  });
