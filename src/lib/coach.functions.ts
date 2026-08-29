import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const CoachInput = z.object({
  /** data URL: data:image/jpeg;base64,... */
  frame: z.string().min(32),
  /** last known game name, helps stability */
  knownGame: z.string().nullable(),
  /** short rolling memory of prior advice */
  recent: z.array(z.string()),
  /** optional player-defined goal that overrides the game's natural objective */
  goal: z.string().max(300).nullable().default(null),
  /** ordered checklist titles for the custom goal, if one has been planned */
  checklist: z.array(z.string()).default([]),
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
  /** 0-based index of the checklist step the player is on, when a checklist was sent */
  stepIndex?: number;
};

export type GoalStep = {
  title: string;
  detail: string;
  advanceSignal: string;
};


const SYSTEM = `You are a veteran player sitting next to someone on the couch. You have completed this game many times and you know its maps, quests, bosses, item locations, upgrade paths and optimal route by heart. The screenshot is only your window into WHERE they are — your advice comes from your knowledge of the whole game, not from describing the picture.

Do this:
1. Identify the game from HUD, art style, UI and level design.
2. READ THE HUD LITERALLY: health, shields, ammo/magazine, stamina, currency, level/XP, lives, timer, score, wave/round, quest tracker, minimap. Only report values you can actually see; never invent them.
3. Work out WHERE they are in the game's progression (area/level/quest/mission name and roughly how far into the campaign).
4. Recall from your knowledge of that game what the required task at this point is and how it is completed, then give the concrete ordered steps to finish it and reach the NEXT milestone toward beating the game. Name real places, NPCs, items, doors, weapons and button prompts when you know them.

Absolute rules:
- NEVER narrate what is happening on screen. Nobody needs to be told what they can see.
- Assume the player has never played this game before: say where to walk, what to pick up, what to equip, what to do at each step.
- If you cannot identify the game with confidence, say so in "objective" and give a generic-but-useful next step.

Reply ONLY with compact JSON, no markdown:
{"game":string,"confidence":number 0-1,"location":area/level/quest name (max 10 words),"stats":[{"label":string,"value":string}] up to 6 HUD readings you can actually see,"objective":the required task right now (max 14 words),"progress":how far along, e.g. "2/5 relics" or "Act 2, ~40% through" (max 10 words),"steps":[2-4 short ordered steps to complete that task, from game knowledge],"action":ONE imperative next action right now (max 12 words),"danger":immediate threat or null,"stepIndex":if a numbered CHECKLIST is given in the user message, the 0-based index of the step they are currently on, else 0}`;

type GatewayFail = { status: number };

function callGateway(key: string, body: unknown) {
  return fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify(body),
  });
}

function failKind({ status }: GatewayFail): NonNullable<CoachResult["error"]> {
  return status === 429 ? "rate_limited" : status === 402 ? "no_credits" : "failed";
}

export const coachFrame = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CoachInput.parse(input))
  .handler(async ({ data }): Promise<CoachResult> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const context = [
      data.knownGame ? `Previously identified game: ${data.knownGame}.` : null,
      data.recent.length ? `Recent advice given: ${data.recent.join(" | ")}.` : null,
      data.goal
        ? `PLAYER'S OWN GOAL (overrides the game's natural objective — plan toward this instead): ${data.goal}`
        : null,
      data.checklist.length
        ? `CHECKLIST for that goal (0-based): ${data.checklist
            .map((s, i) => `${i}. ${s}`)
            .join(" | ")}. Decide which step they are on and return it as stepIndex; keep "steps" focused on completing that step.`
        : null,

    ]
      .filter(Boolean)
      .join(" ");

    const res = await callGateway(key, {
      model: "google/gemini-3.7-flash",
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${context} Read my stats and where I am, then tell me from your knowledge of this game exactly what to do next to progress.`,
            },
            { type: "image_url", image_url: { url: data.frame } },
          ],
        },
      ],
    });

    if (!res.ok) {
      await res.text().catch(() => "");
      const kind = failKind({ status: res.status });
      return {
        error: kind,
        game: data.knownGame ?? "Unknown",
        confidence: 0,
        location: "—",
        stats: [],
        objective: "—",
        progress: "—",
        steps: [],
        action:
          kind === "rate_limited"
            ? "Busy — retrying shortly"
            : kind === "no_credits"
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

const AskInput = z.object({
  frame: z.string().min(32).nullable(),
  question: z.string().min(1).max(400),
  knownGame: z.string().nullable(),
  goal: z.string().max(300).nullable().default(null),
});

/** Free-form question to the coach about the game, answered with the current frame as context. */
export const askCoach = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => AskInput.parse(input))
  .handler(async ({ data }): Promise<{ answer: string; error?: CoachResult["error"] }> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const system = `You are a veteran player who has beaten ${
      data.knownGame ?? "the game on screen"
    } many times and knows every quest, boss, secret, item location and optimal route. Answer the player's question directly and practically, like a friend on the couch: name the places, items, NPCs and button prompts. 3 sentences max, no preamble, no markdown.${
      data.goal ? ` The player's own goal right now is: ${data.goal}.` : ""
    }`;

    const content: Array<Record<string, unknown>> = [{ type: "text", text: data.question }];
    if (data.frame) content.push({ type: "image_url", image_url: { url: data.frame } });

    const res = await callGateway(key, {
      model: "google/gemini-3.7-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    });

    if (!res.ok) {
      await res.text().catch(() => "");
      const kind = failKind({ status: res.status });
      return {
        error: kind,
        answer:
          kind === "rate_limited"
            ? "Rate limited — ask again in a few seconds."
            : kind === "no_credits"
              ? "Out of AI credits."
              : "Couldn't answer that one.",
      };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { answer: json.choices?.[0]?.message?.content?.trim() || "No answer." };
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
