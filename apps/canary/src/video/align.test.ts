import { describe, expect, it } from "vitest";
import {
  alignLyricsToSegments,
  parseWhisperSrt,
  similarity,
  tokenize,
  vocalRegion,
} from "./align.js";

describe("parseWhisperSrt", () => {
  it("parses cues, strips ♪, and drops music/filler cues", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:02,580",
      " (upbeat music)",
      "",
      "2",
      "00:00:30,000 --> 00:00:35,000",
      " ♪ Oh ♪",
      "",
      "3",
      "00:00:35,000 --> 00:00:37,560",
      " ♪ The text feels cried ♪",
      "",
    ].join("\n");
    const segs = parseWhisperSrt(srt);
    expect(segs).toEqual([
      { start: 35, end: 37.56, text: "The text feels cried" },
    ]);
  });
});

describe("similarity", () => {
  it("scores exact/near matches high and unrelated low", () => {
    expect(similarity("the text field cries", "the text field cries")).toBeGreaterThan(0.9);
    // mondegreen still registers via bigrams
    expect(similarity("the checkbook feels a sacred vow", "the checkbox seals our sacred vow")).toBeGreaterThan(0.4);
    expect(similarity("the select bends the world", "totally unrelated banana")).toBeLessThan(0.15);
  });
});

describe("alignLyricsToSegments — real free_tagged transcript", () => {
  // The actual whisper (base.en) output for our 3-line song, sung 2 of 3 lines.
  const segments = [
    { start: 35.0, end: 37.56, text: "The text feels cried" },
    { start: 37.56, end: 39.76, text: "The soccer begins" },
    { start: 39.76, end: 44.5, text: "The checkbook feels" },
    { start: 44.5, end: 49.5, text: "The checkbook feels a sacred vow" },
  ];
  const lines = [
    "The text field cries, the saga begins",
    "The checkbox seals our sacred vow",
    "The select bends the whole world to our will",
  ];

  it("times our CLEAN lines to the vocals, merging split cues and dropping the unsung line", () => {
    const aligned = alignLyricsToSegments(lines, segments);
    expect(aligned).toEqual([
      { start: 35.0, end: 39.76, text: "The text field cries, the saga begins" },
      { start: 39.76, end: 49.5, text: "The checkbox seals our sacred vow" },
    ]);
    // The unsung third line is omitted.
    expect(aligned.some((c) => c.text.includes("select"))).toBe(false);
  });

  it("keeps order and never repeats a line", () => {
    const aligned = alignLyricsToSegments(lines, segments);
    const texts = aligned.map((c) => c.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("alignLyricsToSegments — edge cases", () => {
  it("returns [] when nothing matches", () => {
    expect(
      alignLyricsToSegments(["alpha beta"], [{ start: 1, end: 2, text: "zulu yankee" }])
    ).toEqual([]);
  });
  it("returns [] for no segments", () => {
    expect(alignLyricsToSegments(["a line"], [])).toEqual([]);
  });
});

describe("vocalRegion", () => {
  it("pads around the first and last cue, clamped to 0", () => {
    expect(
      vocalRegion([
        { start: 35, end: 37, text: "a" },
        { start: 44, end: 49, text: "b" },
      ])
    ).toEqual({ start: 33.5, end: 50.5 });
    expect(vocalRegion([{ start: 0.5, end: 2, text: "a" }])?.start).toBe(0);
  });
  it("returns null for no segments", () => {
    expect(vocalRegion([])).toBeNull();
  });
});

describe("tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenize("The Text-Field, cries!")).toEqual(["the", "text", "field", "cries"]);
  });
});
