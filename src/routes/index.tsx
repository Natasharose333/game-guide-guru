import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { coachFrame, type CoachResult } from "@/lib/coach.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sidekick — Live AI Game Coach" },
      {
        name: "description",
        content:
          "Share your game window and get instant call-outs: Sidekick recognizes the game you're playing and tells you the next action to survive and reach your objective.",
      },
      { property: "og:title", content: "Sidekick — Live AI Game Coach" },
      {
        property: "og:description",
        content:
          "Real-time AI that watches your gameplay, identifies the game, and calls your next move.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type LogEntry = CoachResult & { id: number; at: string };

function Index() {
  const analyze = useServerFn(coachFrame);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const gameRef = useRef<string | null>(null);
  const recentRef = useRef<string[]>([]);

  const [live, setLive] = useState(false);
  const [intervalSec, setIntervalSec] = useState(2);
  const [current, setCurrent] = useState<CoachResult | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setLive(true);
    } catch {
      setError("Screen share was cancelled or blocked.");
    }
  }, [stop]);

  const tick = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || busyRef.current || video.videoWidth === 0) return;
    busyRef.current = true;
    setThinking(true);
    try {
      const w = 960;
      const h = Math.round((video.videoHeight / video.videoWidth) * w);
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
      const frame = canvas.toDataURL("image/jpeg", 0.6);

      const result = await analyze({
        data: { frame, knownGame: gameRef.current, recent: recentRef.current },
      });

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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("AI_429")
          ? "Rate limited — slowing down. Try a longer interval."
          : msg.includes("AI_402")
            ? "Out of AI credits. Add credits in Lovable to keep coaching."
            : "Couldn't read that frame.",
      );
    } finally {
      busyRef.current = false;
      setThinking(false);
    }
  }, [analyze]);

  useEffect(() => {
    if (!live) return;
    void tick();
    const id = setInterval(() => void tick(), intervalSec * 1000);
    return () => clearInterval(id);
  }, [live, intervalSec, tick]);

  useEffect(() => () => stop(), [stop]);

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
              Share your game window. Sidekick figures out what you're playing and calls
              your next move every {intervalSec}s.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs uppercase tracking-widest text-muted-foreground">
              Every
              <select
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value))}
                className="ml-2 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
              >
                {[2, 3, 5, 8, 12, 20, 30].map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
            </label>
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

        <section className="mt-8 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-panel)]">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
                capture
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-accent" : "bg-border"}`}
                />
                {live ? (thinking ? "analyzing" : "watching") : "idle"}
              </span>
            </div>
            <div className="relative aspect-video bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                className="h-full w-full object-contain"
              />
              {!live && (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  Hit “Start coaching” and pick your game window or full screen.
                </div>
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
                objective
              </p>
              <p className="mt-1 text-sm text-foreground/90">{current?.objective ?? "—"}</p>
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
    </main>
  );
}
