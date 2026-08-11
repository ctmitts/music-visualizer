# Projector work: raymarching, and projecting onto physical art

Notes toward the side quest. Nothing here is built yet — this is the plan.

## First, the terminology

The pieces you've seen are almost certainly **raymarched signed distance
fields**, not ray tracing. The distinction matters because it changes what you
build:

| | what it is | good at | cost |
|---|---|---|---|
| **Raymarching SDFs** | march a ray until a distance function says you hit something | infinite procedural detail, volumetric glow, soft shadows, fractals — the whole "impossible glowing structure" look | one fragment shader, 60 fps |
| **Path tracing** | trace light bounces against real geometry | photoreal materials, accurate light transport | needs a BVH and denoising; overkill here |

Everything psychedelic and generative in that genre is raymarching. It is also
the thing that drops straight into this codebase, because **a raymarch mode is
just a fifth fragment shader reading the same spectral texture** — the
architecture already hands it the audio.

## Driving a raymarcher from the analysis

The features are already computed and already on the GPU. The mapping that
works:

| spectral feature | SDF parameter | why |
|---|---|---|
| bass band energy | global scale / breathing | the room feels the low end, so the geometry should |
| `flux` (onset) | emissive pulse | hits become light, not motion — motion lags, light doesn't |
| `chromaVector` | fractal rotation / fold angle | key changes rotate the structure |
| `coherence` | surface glossiness vs. fog | tonal passages go solid and specular, noisy ones go volumetric |
| `centroid` | palette temperature | bright mixes read warm |

Two rules learned the hard way in this genre:

- **Drive geometry with smoothed values, light with instantaneous ones.** Sharp
  transients on positions produce jitter; on emission they produce punch.
- **Never let the beat drive the camera.** It reads as a cheap zoom. Move the
  camera slowly and independently; let the *structure* respond.

The existing `smoothLevel` / `smoothFlux` in `renderer.ts` already implement the
attack-fast / release-slow envelope this needs.

## Projecting onto physical art

This is the part with real problems, and they are not the ones people expect.

### 1. Geometric alignment

Your projector will not be perpendicular to the artwork, so the image arrives as
a trapezoid. Keystone correction on the projector is lossy and only handles
vertical tilt. Do it in the shader instead: a **corner-pin homography** — drag
four corners, solve the 3×3 matrix, apply in the vertex shader. It's ~40 lines
and it's exact.

Persist the corner positions; you will not want to re-align every session.

### 2. Masking

Anything outside the artwork lands on your wall. You need a mask that clips the
output to the piece's actual silhouette — a polygon you draw once in a
calibration mode, stored alongside the homography.

### 3. Black is not black

**This is the one that ruins first attempts.** A projector showing "black" still
emits light. On a wall that's a visible grey rectangle around your artwork, and
the illusion dies instantly.

Mitigations, in order of effect:

- Mask tightly to the artwork's edge, so the grey box has nowhere to land.
- Kill ambient light; projector contrast is a *ratio*, so a dark room does more
  than a better projector.
- Compose for it — designs that are mostly lit read far better than designs
  that are mostly dark. This visualizer's current aesthetic (bright structure on
  black) is exactly backwards for projection and would need inverting.
- If the art is on canvas with real texture, raking the projector at a shallow
  angle lets the physical texture cast its own micro-shadows, which sells the
  effect enormously.

### 4. Make the art participate

This is what separates "screen taped over a painting" from a piece that feels
alive. Photograph the artwork once, rectify it through the same homography, and
use it as an input texture — then modulate the visuals *by* it:

- Use the artwork's **luminance** as a mask so light only pools where the
  painting is already light.
- Use its **gradient** as the flow field, replacing the spectral gradient in
  `modeFlow`. Energy then runs along the brushstrokes instead of across them.
- Use its **edges** as emission sites so onsets ignite along the composition's
  own lines.

That last set is nearly free here — `modeFlow` is already a line-integral
convolution over a gradient field. Swapping in the artwork's gradient and
keeping audio as the modulation is a small change to a shader that already
works, and it is probably the highest-payoff thing on this page.

## Suggested order

1. Corner-pin homography + mask, in the existing visualizer window. Useful
   immediately, and nothing else works without it.
2. Artwork-as-flow-field in `modeFlow`. Biggest visual payoff per line of code.
3. Raymarch mode as a fifth shader.

Steps 1 and 2 are each an afternoon. Step 3 is open-ended in the way that
generative art always is.
