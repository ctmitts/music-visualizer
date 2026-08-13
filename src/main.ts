/**
 * Standalone demo host.
 *
 * Everything here is glue — file/mic plumbing and controls. The visualizer
 * itself only ever sees an `AudioSource`, which is why the same engine drops
 * into Mix Table with a different source and no other changes.
 */
import { Visualizer } from "./visualizer";
import { WebAudioSource } from "./sources/webaudio";
import { MODES, type Mode } from "./render/renderer";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const panel = document.getElementById("panel")!;

let viz: Visualizer;
try {
  viz = new Visualizer(canvas, { mode: "mandala" });
} catch (err) {
  statusEl.textContent = String(err);
  throw err;
}
viz.start();

let audioCtx: AudioContext | null = null;
let currentNode: AudioBufferSourceNode | MediaStreamAudioSourceNode | null = null;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

async function attachTo(build: (ctx: AudioContext) => AudioNode) {
  if (!audioCtx) audioCtx = new AudioContext();
  await audioCtx.resume();

  currentNode?.disconnect();
  const node = build(audioCtx);
  currentNode = node as AudioBufferSourceNode | MediaStreamAudioSourceNode;

  await viz.attach(new WebAudioSource(audioCtx, node));
}

// --- file playback ---------------------------------------------------------

async function playFile(file: File) {
  setStatus(`decoding ${file.name}…`);
  if (!audioCtx) audioCtx = new AudioContext();
  const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());

  await attachTo((ctx) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
    return src;
  });
  setStatus(`playing ${file.name} · ${audioCtx.sampleRate} Hz`);
}

const fileInput = document.getElementById("audiofile") as HTMLInputElement;
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void playFile(f).catch((e) => setStatus(String(e)));
});

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) void playFile(f).catch((err) => setStatus(String(err)));
});

// --- microphone ------------------------------------------------------------

document.getElementById("mic")!.addEventListener("click", () => {
  void (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Every one of these would fight the analysis: AGC flattens dynamics,
        // noise suppression carves holes in the spectrum, and echo
        // cancellation is actively adaptive.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await attachTo((ctx) => ctx.createMediaStreamSource(stream));
      setStatus(`microphone live · ${audioCtx!.sampleRate} Hz`);
    } catch (e) {
      setStatus(String(e));
    }
  })();
});

// --- controls --------------------------------------------------------------

const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];
function selectMode(mode: Mode) {
  viz.setMode(mode);
  modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}
modeButtons.forEach((b) =>
  b.addEventListener("click", () => selectMode(b.dataset.mode as Mode)),
);

function slider(id: string, out: string, apply: (v: number) => void, fmt: (v: number) => string) {
  const el = document.getElementById(id) as HTMLInputElement;
  const label = document.getElementById(out)!;
  const update = () => {
    const v = parseFloat(el.value);
    apply(v);
    label.textContent = fmt(v);
  };
  el.addEventListener("input", update);
  update();
}

slider("s-window", "v-window", (v) => (viz.params.windowSeconds = v), (v) => `${v.toFixed(1)} s`);
slider("s-fade", "v-fade", (v) => (viz.params.fadeSeconds = v), (v) => `${v.toFixed(1)} s`);
slider("s-sym", "v-sym", (v) => (viz.params.symmetry = v), (v) => `${v}`);
slider("s-hue", "v-hue", (v) => (viz.params.hueDriftRpm = v), (v) => `${v.toFixed(1)} rpm`);
slider("s-gain", "v-gain", (v) => (viz.params.gain = v), (v) => v.toFixed(2));
slider("s-sat", "v-sat", (v) => (viz.params.saturation = v), (v) => v.toFixed(2));
slider("s-sync", "v-sync", (v) => (viz.params.syncOffsetMs = v), (v) => `${v | 0} ms`);

// --- keyboard --------------------------------------------------------------

let paused = false;
document.addEventListener("keydown", (e) => {
  if (e.key >= "1" && e.key <= "4") {
    selectMode(MODES[+e.key - 1]);
  } else if (e.key.toLowerCase() === "h") {
    panel.classList.toggle("dim");
  } else if (e.key.toLowerCase() === "f") {
    // Drag the window onto the TV display first, then fullscreen it there —
    // requestFullscreen targets whichever screen the window is already on.
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
      panel.classList.add("dim");
    }
  } else if (e.code === "Space") {
    e.preventDefault();
    paused = !paused;
    paused ? viz.stop() : viz.start();
    setStatus(paused ? "paused" : "");
  }
});

setStatus("waiting for audio");

// Dev-only handle: lets you drive the engine from the console (and lets an
// automated check feed it a synthetic sweep without a file picker).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__viz = {
    viz,
    selectMode,
    /**
     * A known signal with a known picture: an A major triad (sustained
     * horizontal lines), a sawtooth sweep (a rising diagonal plus its harmonic
     * stack), and a whisper of noise (a faint desaturated wash). If the
     * waterfall does not show exactly that, the analysis is wrong.
     */
    async testTone() {
      await attachTo((ctx) => {
        const out = ctx.createGain();
        out.gain.value = 0.5;

        for (const f of [220, 277.18, 329.63]) {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.value = f;
          const g = ctx.createGain();
          g.gain.value = 0.18;
          o.connect(g).connect(out);
          o.start();
        }

        const sweep = ctx.createOscillator();
        sweep.type = "sawtooth";
        sweep.frequency.setValueAtTime(110, ctx.currentTime);
        sweep.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 10);
        const sg = ctx.createGain();
        sg.gain.value = 0.12;
        sweep.connect(sg).connect(out);
        sweep.start();

        const noise = ctx.createBufferSource();
        const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.02;
        noise.buffer = buf;
        noise.loop = true;
        noise.connect(out);
        noise.start();

        // Deliberately NOT connected to ctx.destination. The tap worklet keeps
        // this branch of the graph pulled through its own muted sink, so the
        // analysis runs at full fidelity while nothing reaches the speakers.
        return out;
      });
      setStatus("test tone (silent)");
    },
  };
}
