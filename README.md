# Spectral Visualizer

A phase-aware music visualizer. Four ways of looking at one time-frequency
field, built to run standalone in a browser or embedded in the
[Mix Table](../../Desktop/music-mixer) DJ app.

```bash
npm install && npm run dev
```

Drop an audio file on the window, or click **Use microphone**.
`1`–`4` switch modes, `H` hides the panel, `F` goes fullscreen, `Space` pauses.

---

## The idea

Three corrections to the obvious approach, each of which changes the result:

**1. The decomposition is the *forward* transform.** The inverse FT rebuilds a
waveform from a spectrum; it is never needed here. What produces the
frequency-density-per-unit-time picture is the short-time Fourier transform,
and a **Gabor transform is exactly an STFT with a Gaussian window** — the same
object, and the Gaussian is the window that minimizes the time-bandwidth
uncertainty product. Both are available in [`window.ts`](src/core/window.ts);
Hann is the default for reasons given below.

**2. Do not FFT a 5–10 second block.** A 10 s window buys 0.1 Hz of frequency
resolution and destroys every bit of time detail — one smeared static smudge
per block. The two timescales have to be nested:

| | size | meaning |
|---|---|---|
| **Analysis frame** | 4096 samples (85 ms @ 48k), hop 1024 | what the FFT actually sees — ~47 frames/sec |
| **Display window** | 1–20 s, on a slider | how much history is on screen at once |

The 5–10 s figure is the *second* number. It never touches the FFT.

**3. Phase is where the music is.** Raw per-bin phase looks like noise, so
almost every visualizer throws it away and plots magnitude only. Its
*derivatives* are deeply musical:

| quantity | what it measures | drives |
|---|---|---|
| **∂φ/∂t** | instantaneous frequency — the true partial frequency, to far finer than one bin | **hue**, via pitch class |
| **∂f/∂t** | how still that frequency holds frame to frame | **saturation** |
| **∂\|X\|/∂t** | half-wave-rectified spectral flux | **transient bloom** |
| **\|X\|** | energy | **lightness** |

This is the phase-vocoder trick, and it is what makes the picture *mean*
something. A 4096-point FFT has 11.7 Hz bins — nowhere near enough to separate
A1 (55 Hz) from A#1 (58.3 Hz). The instantaneous frequency recovers it anyway,
because the phase advance between frames pins the partial to a small fraction
of a bin.

### Why hue = pitch class

Instantaneous frequency is converted to a pitch class and mapped around the hue
circle. The consequences are the good part:

- **A note keeps its colour in every octave.** Octaves are unisons in colour.
- **Harmonically related notes get related colours**, so a chord is a stable
  palette rather than an arbitrary one.
- **A key change visibly rotates the whole image.**
- **Noise has no pitch class**, so its instantaneous frequency scribbles, its
  coherence collapses, and it desaturates to grey on its own. Cymbals and
  breath go silver; a held synth note goes vivid. Nothing had to be
  special-cased to make that happen.

Colour is computed in **Oklab**, so equal numeric steps look like equal
perceptual steps and the hue wheel doesn't lurch through a muddy yellow-green.

---

## Architecture

```
AudioSource ──► StftAnalyzer ──► RGBA8 ring texture ──► one fragment shader
(where samples    (FFT + phase     324 log bins ×          (four coordinate
 come from)        derivatives)     1024 frames             mappings)
```

The whole design turns on the middle box. Every frame is packed into one texel
row — `R` magnitude, `G` pitch class, `B` coherence, `A` transient — and
**all four visual modes read that same texture**, differing only in how they
map screen position into it. Switching modes is therefore a `mix()` between two
coordinate mappings, not a second render pipeline, which is why crossfades are
free and why adding a fifth mode is about fifteen lines of GLSL.

Frequency is resampled onto a **log axis** (3 bins per semitone, 9 octaves from
A0) before it hits the texture, so octaves are evenly spaced and harmonic
structure is geometric in every mode.

Analysis is driven by *sample arrival*, so frames land on exact hop boundaries;
drawing is driven by `requestAnimationFrame`. The two rates are deliberately
decoupled and the history texture is the buffer between them.

### The four modes

| mode | mapping | what it's for |
|---|---|---|
| **Waterfall** | x = time, y = log frequency | The literal spectrogram. Least abstract — trust this one when checking whether the analysis is right. |
| **Mandala** | radius = frequency, angle = time | Sustained tones are rings, sweeps are spirals, drum hits are radial spokes. |
| **Flow** | line-integral convolution along the spectral gradient | Liquid smoke. Colour is smeared *along* streamlines, so each pixel shows the history of energy that flowed through it. |
| **Helix** | angle = pitch class, radius = octave | Every C on one spoke. Chords become fixed geometric figures. |
| **Terrain** | 3D ridgeline landscape, depth = age | The waterfall's data as receding mountain ridges with true occlusion. Depth is linear in age — a perspective exponent was tried and its slope diverges at age zero, shooting new material through the foreground. |

Two non-obvious things had to be fixed to make these readable, both visible as
soon as you run them wrong:

- **The mandala must not fold.** An N-fold kaleidoscope squeezes the entire
  history into 1/N of the circumference, far past the pixel Nyquist limit — the
  result is chevron moiré, not a mandala. Symmetry is applied as a *petal warp
  on the radius* instead: all of the flower geometry, none of the aliasing.
- **Radius must be area-weighted.** Area on a disc grows as r², so a linear
  bin↦radius map hands the top octaves — mostly cymbal wash — more than half the
  picture while the harmonically dense low end is crushed into the middle.
  Biasing the exponent toward 2 equalizes screen area per octave.

---

## Embedding

The renderer only ever sees an [`AudioSource`](src/sources/types.ts). That is
the entire integration surface:

```ts
interface AudioSource {
  readonly sampleRate: number;
  start(onSamples: (chunk: Float32Array) => void): Promise<void>;
  stop(): void;
}
```

```tsx
import { VisualizerView } from "./react/Visualizer";
import { WebAudioSource } from "./sources/webaudio";

<VisualizerView source={new WebAudioSource(ctx, masterGain)} mode="mandala" />
```

Two implementations ship: `WebAudioSource` (taps any `AudioNode`) and
`TauriSource` (taps the Mix Table Rust engine). See
[docs/mixer-integration.md](docs/mixer-integration.md) — Mix Table's audio never
enters the webview, so the tap has to happen in Rust.

For TVs and projectors, see [docs/tv-output.md](docs/tv-output.md). There is a
real A/V sync trap there worth reading before you plug anything in.

---

## Tuning

| control | effect |
|---|---|
| **Window** | seconds of history on screen. Short = tight and rhythmic, long = drifting and architectural. |
| **Symmetry** | petal count in mandala mode. |
| **Hue drift** | slow global rotation, in rpm. `0` keeps colour absolute so pitch class stays readable. |
| **Gain / Saturation** | exposure and colour intensity. |
| **A/V sync** | delays the picture to match output latency. See the TV doc. |

### Detail — the uncertainty principle as a control

The **Detail** setting picks FFT size and hop together. It is the one control
where no setting is "best", because it is trading one physical resolution
against another:

| preset | FFT | hop | frames/s | analysis window | history | columns in a 125 ms view |
|---|---|---|---|---|---|---|
| coarse | 8192 | 1024 | 47 | 171 ms | 87 s | 5.9 |
| balanced | 4096 | 512 | 94 | 85 ms | 44 s | 11.7 |
| fine | 2048 | 256 | 188 | 43 ms | 22 s | 23.4 |
| ultra | 1024 | 128 | 375 | 21 ms | 11 s | 46.9 |

**The analysis window is the real floor on time resolution, not the hop.** A
shorter hop adds columns, but consecutive columns overlap by 87.5%, so they are
not independent. At `coarse`, a 125 ms display window is *shorter than a single
analysis window* — you get 6 columns of heavily-correlated mush no matter how
you set anything else. To actually see inside a drum hit you need a shorter
FFT, which costs you the ability to tell a bass note from its neighbour.

Measured CPU is **3–4% of one core at every preset** — halving the FFT halves
per-frame cost while doubling the frame rate, so the two cancel. `ultra` is
effectively free; the reason not to use it everywhere is spectral resolution,
not speed.

The **Window** slider is logarithmic and spans 0.125 s to 20 s.

---

## Status

GPU cost per frame at 1504×1828, measured with a forced sync:

| waterfall | flow | mandala | helix |
|---|---|---|---|
| 0.17 ms | 0.10 ms | 0.04 ms | 0.03 ms |

Waterfall is the most expensive — 64 ridgeline rows with hidden-surface
removal — and still uses ~1% of a 60 fps frame budget, so 4K has ample
headroom. The production bundle is 26 kB.

Verified against a synthetic signal with a known picture — an A major triad, a
sawtooth sweep, and low-level noise. The sawtooth's harmonics are evenly spaced
in *linear* frequency, so on a log axis they must visibly converge as they
rise; they do.

**Known limitation.** Below ~100 Hz the log bins are narrower than the FFT's
linear bins, so several log bins read the same FFT bin and the bottom of the
picture goes blocky. This is inherent to a single-resolution STFT. The fix is a
multi-resolution analysis — a longer FFT for the low bands, short for the
high — which is the obvious next thing to build.
