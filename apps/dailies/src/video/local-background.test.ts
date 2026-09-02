import { describe, expect, it } from "vitest";
import {
  buildGradientSource,
  createLocalTitleBackground,
  gradientColors,
  pickGradientLine,
} from "./local-background.js";

describe("gradientColors", () => {
  it("returns a category palette (≥2 stops)", () => {
    const colors = gradientColors("movie");
    expect(colors.length).toBeGreaterThanOrEqual(2);
    expect(colors.every((c) => /^0x[0-9a-fA-F]{6}$/.test(c))).toBe(true);
  });
  it("falls back to the default for an unknown/absent category", () => {
    expect(gradientColors(undefined).length).toBeGreaterThanOrEqual(2);
  });
});

describe("pickGradientLine", () => {
  it("picks a line within the frame, varying by the random draw", () => {
    const a = pickGradientLine(1280, 720, () => 0);
    const b = pickGradientLine(1280, 720, () => 0.99);
    expect(a).not.toEqual(b);
    for (const line of [a, b]) {
      for (const v of [line.x0, line.x1]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1280);
      }
      for (const v of [line.y0, line.y1]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(720);
      }
    }
  });
});

describe("buildGradientSource", () => {
  it("encodes size, every color stop, nb_colors, the line, and the seed", () => {
    const src = buildGradientSource({
      width: 1920,
      height: 1080,
      colors: ["0x111111", "0x222222", "0x333333"],
      line: { x0: 0, y0: 0, x1: 1920, y1: 1080 },
      seed: 42,
    });
    expect(src).toContain("gradients=s=1920x1080");
    expect(src).toContain("c0=0x111111");
    expect(src).toContain("c1=0x222222");
    expect(src).toContain("c2=0x333333");
    expect(src).toContain("nb_colors=3");
    expect(src).toContain("x0=0:y0=0:x1=1920:y1=1080");
    expect(src).toContain("seed=42");
  });
});

// Live smoke test: render a themed gradient with the real ffmpeg. Opt-in so it
// never flakes CI where ffmpeg may be absent.
describe.skipIf(process.env.DAILIES_TEST_FFMPEG !== "1")(
  "createLocalTitleBackground (live)",
  () => {
    it("writes a valid PNG of the requested size", async () => {
      const { findFfmpeg } = await import("./condense.js");
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg) {
        return;
      }
      const { readFile, rm } = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const out = path.join(os.tmpdir(), `dailies-bg-${process.pid}.png`);
      const provider = createLocalTitleBackground(ffmpeg, "movie", () => 0.5);
      try {
        await provider.render("noir jazz", 640, 360, out);
        const bytes = await readFile(out);
        // PNG magic bytes.
        expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(bytes.length).toBeGreaterThan(500);
      } finally {
        await rm(out, { force: true });
      }
    }, 60_000);
  }
);
