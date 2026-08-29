import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  askCoach,
  coachFrame,
  planGoal,
  speakLine,
  type CoachResult,
  type GoalStep,
} from "@/lib/coach.functions";
import { createBackgroundTimer } from "@/lib/background-timer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sidekick — Live AI Game Coach" },
      {
        name: "description",
        content:
          "Share your game window and get spoken call-outs: Sidekick reads your HUD stats, knows where you are, and calls the next step to finish the task and beat the game.",
      },
      { property: "og:title", content: "Sidekick — Live AI Game Coach" },
      {
        property: "og:description",
        content:
          "Real-time AI that reads your stats, tracks your objective, and speaks your next move aloud.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type LogEntry = CoachResult & { id: number; at: string };

/** How different two frames must be (0-1) before we spend an analysis call. */
const SENSITIVITY = {
  high: 0.02,
  medium: 0.05,
  low: 0.1,
} as const;
type Sensitivity = keyof typeof SENSITIVITY;

/** Cheap scene-change detector: 64x36 grayscale fingerprint compared frame to frame. */
const PROBE_W = 64;
const PROBE_H = 36;
/** Never analyze more often than this, no matter how much moves. */
const MIN_GAP_MS = 4000;
/** How often we run the (very cheap) local change probe. */
const PROBE_MS = 1200;

function Index() {
  const analyze = useServerFn(coachFrame);
  const ask = useServerFn(askCoach);
  const makePlan = useServerFn(planGoal);
  const tts = useServerFn(speakLine);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const probeRef = useRef<HTMLCanvasElement | null>(null);
  const prevProbeRef = useRef<Uint8Array | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const busyRef = useRef(false);
  const gameRef = useRef<string | null>(null);
  const recentRef = useRef<string[]>([]);
  const spokenRef = useRef<string>("");
  const voiceRef = useRef(true);
  const cooldownRef = useRef(0);
  const backoffRef = useRef(0);
  const lastAnalyzeRef = useRef(0);
  const goalRef = useRef("");

  const [live, setLive] = useState(false);
  const [maxGapSec, setMaxGapSec] = useState(20);
  const [sensitivity, setSensitivity] = useState<Sensitivity>("medium");
  const [lowImpact, setLowImpact] = useState(true);
  const [voice, setVoice] = useState(true);
  const [current, setCurrent] = useState<CoachResult | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [change, setChange] = useState(0);

  const [goal, setGoal] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [plan, setPlan] = useState<GoalStep[]>([]);
  const [planGoalText, setPlanGoalText] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const [planning, setPlanning] = useState(false);
  const planRef = useRef<GoalStep[]>([]);
  const stepIdxRef = useRef(0);

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    goalRef.current = goal.trim();
  }, [goal]);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);
  useEffect(() => {
    stepIdxRef.current = stepIdx;
  }, [stepIdx]);


  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
    prevProbeRef.current = null;
    setLive(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // 1 fps capture: enough for sampling, far cheaper on the GPU/encoder
        video: { frameRate: { ideal: 1, max: 1 }, width: { max: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => stop());
      // Force the capture pipeline down even if the picker ignored our hints —
      // remote play already eats encode bandwidth on this laptop.
      try {
        await track?.applyConstraints({
          frameRate: { max: 1 },
          width: { max: lowImpact ? 960 : 1280 },
        });
      } catch {
        /* constraint unsupported on this source */
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      prevProbeRef.current = null;
      lastAnalyzeRef.current = 0;
      setLive(true);
    } catch {
      setError("Screen share was cancelled or blocked.");
    }
  }, [stop, lowImpact]);

  const speak = useCallback(
    async (text: string) => {
      if (!voiceRef.current || !text || text === spokenRef.current) return;
      spokenRef.current = text;
      try {
        const { audio } = await tts({ data: { text } });
        if (!audio) throw new Error("no-audio");
        const el = audioRef.current ?? new Audio();
        audioRef.current = el;
        el.src = `data:audio/mpeg;base64,${audio}`;
        await el.play();
      } catch {
        // fall back to the built-in browser voice (free, zero latency)
        try {
          window.speechSynthesis?.cancel();
          window.speechSynthesis?.speak(new SpeechSynthesisUtterance(text));
        } catch {
          /* no voice available */
        }
      }
    },
    [tts],
  );

  /** Grabs a full-size JPEG of the current video frame. */
  const grabFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return null;
    const w = lowImpact ? 640 : 1024;
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", lowImpact ? 0.5 : 0.7);
  }, [lowImpact]);

  const runAnalysis = useCallback(async () => {
    if (busyRef.current) return;
    if (Date.now() < cooldownRef.current) return;
    const frame = grabFrame();
    if (!frame) return;
    busyRef.current = true;
    lastAnalyzeRef.current = Date.now();
    setThinking(true);
    try {
      const result = await analyze({
        data: {
          frame,
          knownGame: gameRef.current,
          recent: recentRef.current,
          goal: goalRef.current || null,
          checklist: planRef.current.map((s) => s.title),
        },
      });


      if (result.error) {
        if (result.error === "rate_limited") {
          const wait = Math.min(60, Math.max(10, 10 * (backoffRef.current + 1)));
          backoffRef.current += 1;
          cooldownRef.current = Date.now() + wait * 1000;
          setError(`Rate limited — pausing ${wait}s, then retrying automatically.`);
        } else if (result.error === "no_credits") {
          cooldownRef.current = Date.now() + 60_000;
          setError("Out of AI credits. Add credits in Lovable to keep coaching.");
        } else {
          setError("Couldn't read that frame.");
        }
        return;
      }
      backoffRef.current = 0;
      gameRef.current = result.game !== "Unknown" ? result.game : gameRef.current;
      recentRef.current = [...recentRef.current, result.action].slice(-4);
      setCurrent(result);
      setLog((prev) =>
        [
          {
            ...result,
            id: Date.now(),
            at: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),
          },
          ...prev,
        ].slice(0, 40),
      );
      setError(null);

      const steps = planRef.current;
      if (steps.length && typeof result.stepIndex === "number") {
        const next = Math.max(stepIdxRef.current, result.stepIndex);
        if (next !== stepIdxRef.current) {
          stepIdxRef.current = next;
          setStepIdx(next);
          const s = steps[next];
          if (s) {
            spokenRef.current = "";
            void speak(
              `Step ${next + 1}. ${s.title}. ${s.detail} Move on when ${s.advanceSignal}.`,
            );
            return;
          }
        }
      }
      void speak(result.danger ? `${result.danger}. ${result.action}` : result.action);

    } catch {
      setError("Couldn't reach the coach. Retrying on the next change.");
    } finally {
      busyRef.current = false;
      setThinking(false);
      lastAnalyzeRef.current = Date.now();
    }
  }, [analyze, grabFrame, speak]);

  /**
   * Cheap local probe: downscale the frame to 64x36, compare with the previous
   * fingerprint, and only spend an AI call when the scene actually changed
   * (or when the heartbeat interval has elapsed).
   */
  const probe = useCallback(() => {
    const video = videoRef.current;
    const canvas = probeRef.current;
    if (!video || !canvas || video.videoWidth === 0) return;
    canvas.width = PROBE_W;
    canvas.height = PROBE_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, PROBE_W, PROBE_H);
    const { data: px } = ctx.getImageData(0, 0, PROBE_W, PROBE_H);
    const gray = new Uint8Array(PROBE_W * PROBE_H);
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      gray[p] = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
    }

    const prev = prevProbeRef.current;
    prevProbeRef.current = gray;
    const since = Date.now() - lastAnalyzeRef.current;

    if (!prev) {
      void runAnalysis();
      return;
    }
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i]! - prev[i]!);
    const diff = sum / gray.length / 255;
    setChange(diff);

    const changed = diff >= SENSITIVITY[sensitivity];
    const heartbeat = since >= maxGapSec * 1000;
    if ((changed && since >= MIN_GAP_MS) || heartbeat) void runAnalysis();
  }, [runAnalysis, sensitivity, maxGapSec]);

  const probeFnRef = useRef(probe);
  useEffect(() => {
    probeFnRef.current = probe;
  }, [probe]);

  useEffect(() => {
    if (!live) return;
    // worker-driven so sampling keeps going while the Xbox app window has focus
    return createBackgroundTimer(() => probeFnRef.current(), PROBE_MS);
  }, [live]);

  useEffect(() => () => stop(), [stop]);

  const buildPlan = useCallback(async () => {
    const g = goal.trim();
    if (g.length < 3 || planning) return;
    setPlanning(true);
    setError(null);
    try {
      const res = await makePlan({
        data: { goal: g, knownGame: gameRef.current, frame: grabFrame() },
      });
      if (res.error || res.steps.length === 0) {
        setError(
          res.error === "rate_limited"
            ? "Rate limited — try planning again in a few seconds."
            : res.error === "no_credits"
              ? "Out of AI credits."
              : "Couldn't build a checklist for that goal.",
        );
        return;
      }
      setPlan(res.steps);
      planRef.current = res.steps;
      setPlanGoalText(g);
      setStepIdx(0);
      stepIdxRef.current = 0;
      const first = res.steps[0]!;
      spokenRef.current = "";
      void speak(
        `Step 1. ${first.title}. ${first.detail} Move on when ${first.advanceSignal}.`,
      );
    } catch {
      setError("Couldn't reach the coach to plan that goal.");
    } finally {
      setPlanning(false);
    }
  }, [goal, planning, makePlan, grabFrame, speak]);

  const clearPlan = useCallback(() => {
    setPlan([]);
    planRef.current = [];
    setStepIdx(0);
    stepIdxRef.current = 0;
    setPlanGoalText("");
  }, []);



  const submitQuestion = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = question.trim();
      if (!q || asking) return;
      setAsking(true);
      setAnswer(null);
      try {
        const res = await ask({
          data: {
            frame: grabFrame(),
            question: q,
            knownGame: gameRef.current,
            goal: goalRef.current || null,
          },
        });
        setAnswer(res.answer);
        spokenRef.current = "";
        void speak(res.answer);
      } catch {
        setAnswer("Couldn't reach the coach — try again.");
      } finally {
        setAsking(false);
      }
    },
    [ask, asking, grabFrame, question, speak],
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,var(--glow-a),transparent_55%),radial-gradient(circle_at_85%_10%,var(--glow-b),transparent_50%)]" />
      <div className="relative mx-auto max-w-6xl px-5 py-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-display text-xs uppercase tracking-[0.4em] text-accent">
              live overlay coach
            </p>
            <h1 className="font-display mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
              Sidekick
            </h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Share your game window. Sidekick only spends an AI call when the scene
              actually changes, and checks in at least every {maxGapSec}s.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs uppercase tracking-widest text-muted-foreground">
              Trigger
              <select
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value as Sensitivity)}
                className="ml-2 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
              >
                <option value="high">Any change</option>
                <option value="medium">Real changes</option>
                <option value="low">Big changes</option>
              </select>
            </label>
            <label className="text-xs uppercase tracking-widest text-muted-foreground">
              Check-in
              <select
                value={maxGapSec}
                onChange={(e) => setMaxGapSec(Number(e.target.value))}
                className="ml-2 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
              >
                {[10, 15, 20, 30, 45, 60].map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setVoice((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-xs uppercase tracking-widest transition-colors ${
                voice
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground"
              }`}
            >
              {voice ? "Voice on" : "Voice off"}
            </button>
            <button
              onClick={() => setLowImpact((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-xs uppercase tracking-widest transition-colors ${
                lowImpact
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground"
              }`}
            >
              {lowImpact ? "Low impact" : "Full quality"}
            </button>
            <button
              onClick={live ? stop : start}
              className={`font-display rounded-md px-5 py-2.5 text-sm font-semibold uppercase tracking-widest transition-colors ${
                live
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              {live ? "Stop" : "Start coaching"}
            </button>
          </div>
        </header>

        {live && (
          <p className="mt-5 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-sm text-foreground/85">
            <strong className="font-semibold text-accent">Click back into the Xbox app window now.</strong>{" "}
            Your controller only reaches the game while that window has focus — if this
            browser tab is focused, buttons like drawing a weapon get swallowed. Sidekick
            keeps watching and talking in the background.
          </p>
        )}

        <section className="mt-8 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-5">
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-panel)]">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
                  capture
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-accent" : "bg-border"}`}
                  />
                  {live
                    ? thinking
                      ? "analyzing"
                      : `watching · scene change ${Math.round(change * 100)}%`
                    : "idle"}
                </span>
              </div>
              <div className="relative aspect-video bg-black">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className={`h-full w-full object-contain ${lowImpact ? "invisible" : ""}`}
                />
                {(!live || lowImpact) && (
                  <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                    {!live
                      ? "Hit “Start coaching” and pick your game window or full screen."
                      : "Low impact mode — preview hidden to keep your game smooth."}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <p className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
                your goal (optional)
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Going off the main story? Tell Sidekick what you're actually trying to do
                and it plans toward that instead.
              </p>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={2}
                placeholder="e.g. Farm gold for the best sword, then find all the shrines in this region"
                className="mt-3 w-full resize-none rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-accent/60"
              />
              {goal.trim() && (
                <p className="mt-2 text-xs text-accent">
                  Coaching toward your goal instead of the default objective.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void buildPlan()}
                  disabled={planning || goal.trim().length < 3}
                  className="font-display rounded-md bg-primary px-4 py-2 text-xs font-semibold uppercase tracking-widest text-primary-foreground disabled:opacity-40"
                >
                  {planning
                    ? "Planning…"
                    : plan.length
                      ? "Re-plan checklist"
                      : "Build checklist"}
                </button>
                {plan.length > 0 && (
                  <button
                    onClick={clearPlan}
                    className="rounded-md border border-border px-3 py-2 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              {plan.length > 0 && planGoalText !== goal.trim() && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Goal changed — re-plan to update the checklist.
                </p>
              )}
            </div>

            {plan.length > 0 && (
              <div className="rounded-xl border border-accent/40 bg-card p-5 shadow-[var(--shadow-panel)]">
                <div className="flex items-center justify-between">
                  <p className="font-display text-xs uppercase tracking-[0.3em] text-accent">
                    goal checklist
                  </p>
                  <span className="text-xs text-muted-foreground">
                    step {Math.min(stepIdx + 1, plan.length)} of {plan.length}
                  </span>
                </div>
                <ol className="mt-4 space-y-3">
                  {plan.map((s, i) => {
                    const done = i < stepIdx;
                    const active = i === stepIdx;
                    return (
                      <li
                        key={s.title}
                        className={`rounded-lg border px-3 py-2.5 ${
                          active
                            ? "border-accent/60 bg-accent/10"
                            : "border-border bg-background/40"
                        }`}
                      >
                        <div className="flex gap-2">
                          <span
                            className={`font-mono text-xs ${done ? "text-muted-foreground" : "text-accent"}`}
                          >
                            {done ? "✓" : i + 1}
                          </span>
                          <div className="flex-1">
                            <p
                              className={`text-sm font-semibold ${
                                done
                                  ? "text-muted-foreground line-through"
                                  : "text-foreground"
                              }`}
                            >
                              {s.title}
                            </p>
                            {active && (
                              <p className="mt-1 text-sm text-foreground/90">
                                <span className="text-xs uppercase tracking-widest text-accent">
                                  do now ·{" "}
                                </span>
                                {s.detail}
                              </p>
                            )}
                            {!done && s.advanceSignal && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                advance when: {s.advanceSignal}
                              </p>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      const s = plan[stepIdx];
                      if (!s) return;
                      spokenRef.current = "";
                      void speak(
                        `Step ${stepIdx + 1}. ${s.title}. ${s.detail} Move on when ${s.advanceSignal}.`,
                      );
                    }}
                    className="rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Read step aloud
                  </button>
                  <button
                    onClick={() => setStepIdx((i) => Math.min(plan.length - 1, i + 1))}
                    disabled={stepIdx >= plan.length - 1}
                    className="rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                  >
                    Mark done · next step
                  </button>
                </div>
              </div>
            )}


            <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <p className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
                ask your sidekick
              </p>
              <form onSubmit={submitQuestion} className="mt-3 flex gap-2">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Where do I find the key for this door?"
                  className="flex-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-accent/60"
                />
                <button
                  type="submit"
                  disabled={asking || !question.trim()}
                  className="font-display rounded-md bg-primary px-4 py-2 text-xs font-semibold uppercase tracking-widest text-primary-foreground disabled:opacity-40"
                >
                  {asking ? "…" : "Ask"}
                </button>
              </form>
              {answer && (
                <p className="mt-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-foreground/90">
                  {answer}
                </p>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <p className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
                your stats
              </p>
              {current?.stats.length ? (
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {current.stats.map((s) => (
                    <div
                      key={s.label}
                      className="rounded-lg border border-border bg-background/40 px-3 py-2"
                    >
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                        {s.label}
                      </p>
                      <p className="font-display text-lg font-semibold">{s.value}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No HUD readings yet.</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <p className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
                detected game
              </p>
              <p className="font-display mt-2 text-2xl font-semibold">
                {current?.game ?? "—"}
              </p>
              <p className="mt-1 text-sm text-foreground/80">{current?.location ?? "—"}</p>
              {current && (
                <p className="mt-1 text-xs text-muted-foreground">
                  confidence {Math.round(current.confidence * 100)}%
                </p>
              )}
            </div>

            <div className="rounded-xl border border-accent/40 bg-card p-5 shadow-[var(--shadow-glow)]">
              <p className="font-display text-xs uppercase tracking-[0.3em] text-accent">
                do this next
              </p>
              <p className="font-display mt-2 text-2xl leading-snug font-bold">
                {current?.action ?? "Waiting for your screen…"}
              </p>
              {current?.danger && (
                <p className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  ⚠ {current.danger}
                </p>
              )}
              <p className="mt-4 text-xs uppercase tracking-widest text-muted-foreground">
                current task · {current?.progress ?? "—"}
              </p>
              <p className="mt-1 text-sm text-foreground/90">{current?.objective ?? "—"}</p>
              {current?.steps.length ? (
                <ol className="mt-3 space-y-1.5 text-sm">
                  {current.steps.map((step, i) => (
                    <li key={step} className="flex gap-2">
                      <span className="font-mono text-xs text-accent">{i + 1}</span>
                      <span className="text-foreground/90">{step}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => {
                    if (!current) return;
                    spokenRef.current = "";
                    void speak([current.action, ...current.steps].filter(Boolean).join(". "));
                  }}
                  disabled={!current}
                  className="rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  Read steps aloud
                </button>
                <button
                  onClick={() => void runAnalysis()}
                  disabled={!live || thinking}
                  className="rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  Check now
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
            call-out log (this session)
          </h2>
          <ul className="mt-3 space-y-2">
            {log.length === 0 && (
              <li className="text-sm text-muted-foreground">No call-outs yet.</li>
            )}
            {log.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-4 rounded-lg border border-border bg-card/60 px-4 py-2.5"
              >
                <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {entry.at}
                </span>
                <span className="flex-1 text-sm">
                  <strong className="font-semibold">{entry.action}</strong>
                  <span className="ml-2 text-muted-foreground">{entry.objective}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <canvas ref={probeRef} className="hidden" />
    </main>
  );
}
