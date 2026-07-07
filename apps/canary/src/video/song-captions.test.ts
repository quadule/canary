import { describe, expect, it } from "vitest";
import type { TimedWord } from "./align.js";
import { selectSongCaptions } from "./song-captions.js";

const LINES = ["She opens the page", "Green lights are shining"];
const LEAD = 3;
const MAX_CUE = 8;

// Word timeline where both lines are clearly sung (content words only).
function sungWords(): TimedWord[] {
  return [
    { start: 5, end: 5.4, word: "She" },
    { start: 5.5, end: 6, word: "opens" },
    { start: 6.1, end: 6.6, word: "page" },
    { start: 10, end: 10.4, word: "Green" },
    { start: 10.5, end: 11, word: "lights" },
    { start: 11.1, end: 11.8, word: "shining" },
  ];
}

describe("selectSongCaptions", () => {
  it("prefers the model's LRC, onset-synced when word timings exist", () => {
    const plan = selectSongCaptions({
      orderedTexts: LINES,
      lrcText: "[00:04.50]She opens the page\n[00:09.50]Green lights are shining",
      segments: [
        { start: 5, end: 7, text: "she opens the page" },
        { start: 10, end: 12, text: "green lights are shining" },
      ],
      words: sungWords(),
      leadSec: LEAD,
      maxCueSec: MAX_CUE,
    });
    expect(plan.sourceLabel).toBe(
      "the model's lyric timestamps, onset-synced to the vocals"
    );
    expect(plan.clipCues.map((c) => c.text)).toEqual(LINES);
    // Line 1's start is floored at its heard onset (5), not the LRC's 4.5.
    expect(plan.clipCues[0]?.start).toBeGreaterThanOrEqual(5);
    expect(plan.region).not.toBeNull();
  });

  it("uses LRC alone (no onset-sync) when there are no word timings", () => {
    const plan = selectSongCaptions({
      orderedTexts: LINES,
      lrcText: "[00:05.00]She opens the page\n[00:10.00]Green lights are shining",
      segments: [{ start: 5, end: 12, text: "she opens the page green lights" }],
      words: [],
      leadSec: LEAD,
      maxCueSec: MAX_CUE,
    });
    expect(plan.sourceLabel).toBe("the model's own lyric timestamps");
    expect(plan.clipCues.length).toBe(2);
  });

  it("falls back to word-level alignment when there's no LRC", () => {
    const plan = selectSongCaptions({
      orderedTexts: LINES,
      segments: [{ start: 5, end: 12, text: "mashed blob of both lines" }],
      words: sungWords(),
      leadSec: LEAD,
      maxCueSec: MAX_CUE,
    });
    expect(plan.sourceLabel).toBe("the detected vocals, word-timed");
    expect(plan.clipCues.length).toBe(2);
  });

  it("honors useLrc:false to force the transcribe path", () => {
    const plan = selectSongCaptions({
      orderedTexts: LINES,
      lrcText: "[00:05.00]She opens the page\n[00:10.00]Green lights are shining",
      useLrc: false,
      segments: [],
      words: sungWords(),
      leadSec: LEAD,
      maxCueSec: MAX_CUE,
    });
    expect(plan.sourceLabel).toBe("the detected vocals, word-timed");
  });

  it("falls back to segment matching when only segments are available", () => {
    const plan = selectSongCaptions({
      orderedTexts: LINES,
      segments: [
        { start: 5, end: 7, text: "she opens the page" },
        { start: 10, end: 12, text: "green lights are shining" },
      ],
      words: [],
      leadSec: LEAD,
      maxCueSec: MAX_CUE,
    });
    expect(plan.sourceLabel).toBe("the detected vocals");
    expect(plan.clipCues.length).toBeGreaterThan(0);
  });

  it("returns a null region when nothing is available (caller falls back to step-timed)", () => {
    const plan = selectSongCaptions({
      orderedTexts: LINES,
      segments: [],
      words: [],
      leadSec: LEAD,
      maxCueSec: MAX_CUE,
    });
    expect(plan.region).toBeNull();
    expect(plan.clipCues).toEqual([]);
    expect(plan.sourceLabel).toBe("");
  });
});
