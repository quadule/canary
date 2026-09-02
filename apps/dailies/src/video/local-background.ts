// A LOCAL, network-free title-card background: a themed two/three-tone gradient
// drawn by ffmpeg's `gradients` lavfi source. This is the DEFAULT background when
// no generated-image provider (Gemini Nano Banana) is available — mirroring the
// pipeline's other local-first fallbacks (macOS `say` for voice, `drawtext` for
// the title text). It needs no API key and makes no network request, so a plain
// `dailies` install still gets an intentional-looking title card instead of a flat
// black one.
//
// CONTRACT: same TitleBackgroundProvider surface as the Gemini image provider —
// `render()` writes a finished image to `outPath` or throws, and the caller
// (narrate.ts) wraps it so any failure degrades to the solid-black card. The
// title card darkens the background (eq=brightness=-0.25) and lays a scrim behind
// the text, so these palettes are deliberately rich/deep and still read once
// dimmed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TitleBackgroundProvider } from "./providers.js";
import type { ThemeCategory } from "./themes.js";

const execFileAsync = promisify(execFile);

// A gradient render is a single tiny frame; bound it like the other probes.
const RENDER_TIMEOUT_MS = 60_000;

// Deep, cinematic gradient palettes per theme category (2–3 stops each). Chosen
// to match the genre's mood and to survive the title card's darkening + text
// scrim. Pure data → unit-tested via gradientColors.
const GRADIENTS: Record<ThemeCategory, string[]> = {
  movie: ["0x2c3e50", "0x000000"], // noir slate into black
  tv: ["0x0f2027", "0x203a43", "0x2c5364"], // cool broadcast blues
  documentary: ["0x3a3a3a", "0x1c1c1c"], // neutral charcoal
  commercial: ["0xee0979", "0xff6a00"], // vivid pink → orange
  training: ["0x134e5e", "0x71b280"], // teal → green
  radio: ["0x232526", "0x414345"], // warm studio grey
  sports: ["0xc31432", "0x240b36"], // red → deep purple
  game_show: ["0xf8b500", "0x7a1e00"], // gold → burnt amber
  soap: ["0x870000", "0x190a05"], // wine → near-black
  news: ["0x141e30", "0x243b55"], // authoritative navy
  kids: ["0xff5f6d", "0xffc371"], // coral → peach
};

// Fallback when the category is unknown/absent: a deep teal-black.
const DEFAULT_GRADIENT = ["0x0f2027", "0x203a43"];

// The gradient colors for a theme category (or the default). Pure → unit-tested.
export function gradientColors(category: ThemeCategory | undefined): string[] {
  return (category && GRADIENTS[category]) || DEFAULT_GRADIENT;
}

// A gradient line (source → destination) across the frame. Picks one of a few
// diagonal/axis orientations so repeated renders vary a little. Pure (random
// injectable) → unit-tested.
export function pickGradientLine(
  width: number,
  height: number,
  random: () => number = Math.random
): { x0: number; y0: number; x1: number; y1: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const orientations = [
    { x0: 0, y0: 0, x1: w, y1: h }, // top-left → bottom-right
    { x0: w, y0: 0, x1: 0, y1: h }, // top-right → bottom-left
    { x0: 0, y0: 0, x1: 0, y1: h }, // top → bottom
    { x0: 0, y0: h, x1: w, y1: 0 }, // bottom-left → top-right
  ];
  const fallback = { x0: 0, y0: 0, x1: w, y1: h };
  const idx = Math.min(
    orientations.length - 1,
    Math.max(0, Math.floor(random() * orientations.length))
  );
  return orientations[idx] ?? fallback;
}

// Build the `gradients` lavfi source string. Pure → unit-tested. `seed` keeps a
// render reproducible; colors beyond the first two set nb_colors accordingly.
export function buildGradientSource(args: {
  width: number;
  height: number;
  colors: string[];
  line: { x0: number; y0: number; x1: number; y1: number };
  seed: number;
}): string {
  const { width, height, colors, line, seed } = args;
  const stops = colors.length >= 2 ? colors : DEFAULT_GRADIENT;
  const colorParams = stops.map((c, i) => `c${i}=${c}`).join(":");
  return [
    `gradients=s=${Math.round(width)}x${Math.round(height)}`,
    colorParams,
    `nb_colors=${stops.length}`,
    `x0=${line.x0}:y0=${line.y0}:x1=${line.x1}:y1=${line.y1}`,
    `seed=${seed}`,
  ].join(":");
}

// A TitleBackgroundProvider that draws a themed gradient locally with ffmpeg.
// `category` fixes the palette for the whole run (the caller resolves it from the
// creative direction). No network, no key — always available.
export function createLocalTitleBackground(
  ffmpeg: string,
  category: ThemeCategory | undefined,
  random: () => number = Math.random
): TitleBackgroundProvider {
  return {
    id: "local-gradient",
    async render(
      _directionText: string,
      width: number,
      height: number,
      outPath: string
    ): Promise<void> {
      const source = buildGradientSource({
        width,
        height,
        colors: gradientColors(category),
        line: pickGradientLine(width, height, random),
        // A 32-bit seed so run-to-run gradients differ within a palette.
        seed: Math.floor(random() * 0xff_ff_ff_ff),
      });
      await execFileAsync(
        ffmpeg,
        [
          "-hide_banner",
          "-nostats",
          "-y",
          "-f",
          "lavfi",
          "-i",
          source,
          // A single still frame written as an image (‑update silences the
          // image2 "use a pattern" warning for a one-shot write).
          "-update",
          "1",
          "-frames:v",
          "1",
          outPath,
        ],
        { timeout: RENDER_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
      );
    },
  };
}
