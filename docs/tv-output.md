# Putting it on the TV

Audio and video take different paths to the same screen, and they do **not**
arrive at the same time. That is the whole difficulty.

## Audio

Mix Table already has output-device selection with automatic re-decode when the
device sample rate changes. So sending audio to the TV is not a new feature —
pick the TV as the output device.

| route | how it appears | latency |
|---|---|---|
| **HDMI** (Mac → TV) | a normal CoreAudio output device | ~20–50 ms |
| **AirPlay** (Mac → Apple TV) | a normal CoreAudio output device | **~1500–2000 ms** |
| **Optical / AV receiver** | a normal output device | ~50–150 ms, plus whatever DSP the receiver adds |

A TV over HDMI usually reports 48 kHz. If it negotiates something else, the
engine re-decodes and the visualizer must be rebuilt — see the sample-rate note
in [mixer-integration.md](mixer-integration.md).

## Video

Drag the window onto the TV display and press `F`. `requestFullscreen` targets
whichever screen the window is already on, so the order matters.

For Mix Table specifically, the better shape is a **second Tauri window** — the
mixer UI stays on your laptop, the TV gets nothing but the canvas:

```rust
tauri::WebviewWindowBuilder::new(
    app,
    "visualizer",
    tauri::WebviewUrl::App("visualizer.html".into()),
)
.title("Visualizer")
.fullscreen(true)
.build()?;
```

Two Tauri windows are separate webviews with separate JS contexts, so the
second one cannot share the first one's `TauriSource`. Give it its own channel
and fan out in the Rust drain thread — hold a `Vec<Channel<_>>` instead of one
channel and send to each, dropping any that error. Do not try to run two
`rtrb` consumers on one ring; `rtrb` is single-producer/single-consumer and
the second consumer would steal samples from the first.

## The sync trap

**The tap is pre-device.** The visualizer analyzes samples at the moment the
audio callback writes them, but the listener hears them one full output-latency
later. The picture therefore runs *ahead* of the sound by exactly the transport
delay.

Over HDMI that is 20–50 ms — below the threshold where anyone notices.

Over **AirPlay it is about two seconds**, and it looks completely broken: every
kick flashes long before you hear it.

The fix is the `syncOffsetMs` parameter. Because the spectral history is
already an age-indexed ring buffer, delaying the picture costs nothing — the
read cursor is simply held back:

```ts
<VisualizerView source={source} syncOffsetMs={1800} />
```

The history holds ~21 s, so any realistic offset fits with room to spare.

### Getting the number right

Start from what the platform reports. `cpal`'s `OutputCallbackInfo` gives a
`playback` timestamp and a `callback` timestamp; the difference is the device
latency, and it is worth surfacing as the default:

```rust
// inside the output callback
let latency = info.timestamp().playback
    .duration_since(&info.timestamp().callback)
    .unwrap_or_default();
```

Then let the user trim it. CoreAudio does **not** reliably report AirPlay's
full buffering, so the reported figure will be far too small on that path, and
receivers add their own undisclosed DSP delay. A slider is not a cop-out here;
it is the only thing that actually works across every route. The demo app's
**A/V sync** control is exactly this, 0–2500 ms.

To calibrate by eye: play something with a hard, isolated kick, switch to
**waterfall** (the least abstract mode — transients are unambiguous vertical
lines there), and adjust until the line crosses the right edge as you hear the
hit.

## Practical settings for a room

- **Window 10–14 s.** Longer than you'd want on a laptop; from across a room
  the slow architectural drift reads better than tight rhythmic detail.
- **Hue drift 0.5–2 rpm.** Enough to breathe. Set it to `0` if you want colour
  to stay absolute so pitch class remains readable.
- **Gain up slightly** — living-room TVs are usually brighter than a laptop
  panel, but they also sit further away, and the noise gate means the
  background stays genuinely black rather than grey.
- **Mandala and flow** carry a room best. **Waterfall** is for diagnosis, not
  for guests.
- Disable screen sleep on the TV display.

## Performance

Measured at 120 fps at 1504×1828 in the heaviest mode, so 4K at 60 fps has
comfortable headroom. If a weaker GPU struggles, in order of effect: drop
`STEPS` in the flow shader from 8, halve the canvas backing resolution (`dpr`
is already capped at 2 in `renderer.ts`), or raise `hopSize` to 2048 to halve
the analysis rate.
