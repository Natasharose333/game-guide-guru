/**
 * A timer that keeps firing while the tab is in the background.
 *
 * Browsers throttle setInterval on hidden/unfocused tabs, which matters here:
 * the player must keep their game window focused (otherwise the controller
 * input goes to the browser instead of the game). A worker timer plus a silent
 * audio keepalive keeps Sidekick sampling while it sits in the background.
 */
export function createBackgroundTimer(onTick: () => void, everyMs: number) {
  const src = `let id=null;onmessage=(e)=>{if(e.data.type==='start'){clearInterval(id);id=setInterval(()=>postMessage('tick'),e.data.ms);}else{clearInterval(id);id=null;}}`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = () => onTick();
  worker.postMessage({ type: "start", ms: everyMs });

  // Keeps the tab "audible" so the browser does not deep-throttle it.
  let ctx: AudioContext | null = null;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
    }
  } catch {
    /* audio keepalive unavailable */
  }

  return () => {
    worker.postMessage({ type: "stop" });
    worker.terminate();
    URL.revokeObjectURL(url);
    void ctx?.close().catch(() => {});
  };
}
