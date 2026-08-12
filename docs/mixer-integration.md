# Wiring the visualizer into Mix Table

## Why a Web Audio tap cannot work

Mix Table decodes with symphonia, mixes in a lock-free `cpal` callback, and
writes straight to the device. The React UI only ever receives position and
meters over IPC at ~30 Hz. **The audio never enters the webview**, so there is
no `AudioNode` to observe and `WebAudioSource` has nothing to attach to.

The tap has to happen in Rust, next to the audio.

## Where to tap

`engine.rs` already does this once, for recording. In the mix loop:

```rust
let mg = self.master_gain.step();
let (l, r) = self.limiter.process(mix_l * mg, mix_r * mg);
self.scratch[f * 2] = l;
self.scratch[f * 2 + 1] = r;
if let Some(rec) = &mut self.rec_tx {
    // Best-effort: drop samples if the writer stalls rather than
    // ever blocking the audio thread.
    let _ = rec.push(l);
    let _ = rec.push(r);
}
```

That is the correct point (post-master-gain, post-limiter — what the listener
actually hears) and the correct idiom (push into an `rtrb` ring, drop on full,
never block). The visualizer tap mirrors it exactly.

**Do not run the FFT on the audio thread.** An `rtrb` push is a couple of
atomic ops; a 4096-point FFT is not, and a single overrun is an audible click.
The audio thread only ever hands off samples.

## The patch

### 1. `src-tauri/src/engine.rs`

Add the commands, next to `StartRecord`:

```rust
StartViz(Box<rtrb::Producer<f32>>),
StopViz,
```

Add the field, next to `rec_tx`:

```rust
viz_tx: Option<Box<rtrb::Producer<f32>>>,
```

Initialize it to `None` where `rec_tx: None` is set (~line 703).

Handle the commands where `Cmd::StartRecord` is handled (~line 485):

```rust
Cmd::StartViz(producer) => self.viz_tx = Some(producer),
Cmd::StopViz => self.viz_tx = None,
```

And push in the mix loop, right after the `rec_tx` block:

```rust
if let Some(viz) = &mut self.viz_tx {
    // Mono: the analysis is mono anyway, so downmixing here halves the
    // IPC traffic. Same best-effort drop policy as the recorder — the
    // visualizer skipping a frame is invisible, a blocked audio thread
    // is not.
    let _ = viz.push((l + r) * 0.5);
}
```

### 2. `src-tauri/src/lib.rs`

```rust
use tauri::ipc::{Channel, InvokeResponseBody};

#[tauri::command]
fn viz_sample_rate(engine: EngineState) -> u32 {
    engine.sample_rate()
}

#[tauri::command]
fn start_visualizer(
    engine: EngineState,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    // ~2.7 s of mono float at 48 k. The drain runs every 10 ms, so this is
    // enormous slack; it exists so a stalled webview can never back-pressure
    // the audio thread.
    let (producer, mut consumer) = rtrb::RingBuffer::<f32>::new(1 << 17);
    engine.send(Cmd::StartViz(Box::new(producer)));

    std::thread::spawn(move || {
        let mut batch: Vec<f32> = Vec::with_capacity(4096);
        loop {
            batch.clear();
            while let Ok(s) = consumer.pop() {
                batch.push(s);
            }
            if consumer.is_abandoned() && batch.is_empty() {
                break;
            }
            if !batch.is_empty() {
                let mut bytes = Vec::with_capacity(batch.len() * 4);
                for s in &batch {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                // The UI going away is a normal shutdown, not an error.
                if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_visualizer(engine: EngineState) {
    engine.send(Cmd::StopViz);
}
```

Register all three in `invoke_handler!` alongside `start_recording`.

### 3. Link the package — do not copy it

Mix Table consumes this repo as an npm-linked directory dependency:

```bash
npm install ../repos/music-visualizer
```

That symlinks `node_modules/spectral-visualizer` at the sibling checkout, so
edits here hot-reload in the mixer's dev server with no sync step. (An earlier
setup copied `src/` into the mixer; the copy went stale within a day and is
exactly why this section exists.) Two host-side requirements:

- Vite must be allowed to serve source through the symlink:
  `server.fs.allow: [".", "../repos/music-visualizer"]`.
- `@tauri-apps/api` is an optional peer dependency of this package; the host
  supplies the real one.

### 4. React side

```tsx
import { useEffect, useState } from "react";
import { VisualizerView } from "spectral-visualizer/react/Visualizer";
import { TauriSource } from "spectral-visualizer/sources/tauri";

export function MixVisualizer() {
  const [source, setSource] = useState<TauriSource | null>(null);

  useEffect(() => {
    const s = new TauriSource();
    // Read the engine's real device rate before the analyzer is configured —
    // it follows the output device and changes when the user switches it.
    s.prepare().then(() => setSource(s));
    return () => s.stop();
  }, []);

  if (!source) return null;
  return <VisualizerView source={source} mode="mandala" windowSeconds={8} />;
}
```

## Bandwidth

Mono f32 at 48 kHz is **~192 kB/s** over IPC. That is nothing, and it keeps a
single analysis codepath shared with the standalone browser build — worth a lot
more than the bytes.

If the UI thread ever gets tight, the next step is to move `StftAnalyzer` into
that Rust drain thread (`rustfft` is already a dependency, and `analysis.rs`
already runs an STFT for BPM/key) and ship the packed RGBA rows instead:
324 × 4 bytes × 47 fps ≈ **61 kB/s**, with no FFT on the UI thread at all. The
renderer needs no changes — it consumes texel rows either way. Do this only if
profiling says to; it duplicates the DSP in two languages.

## Sample-rate changes

The engine re-decodes when the output device's rate changes. The analyzer
derives its frame rate from `sampleRate`, so it must be rebuilt when that
happens — call `stop()`, re-`prepare()`, and re-`attach()`. Rebuilding the
`Visualizer` also drops the spectral history, so the picture restarts; that is
correct, since the old history was analyzed at a different rate.
