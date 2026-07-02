import { describe, expect, it } from "vitest";
import {
  alignLyricsToSegments,
  cleanSegmentText,
  mainCluster,
  parseWhisperSrt,
  segmentsFromOpenAI,
  similarity,
  tokenize,
  vocalRegion,
} from "./align.js";

describe("segmentsFromOpenAI", () => {
  it("maps verbose_json segments to start/end/text and cleans them", () => {
    const body = {
      segments: [
        { start: 0, end: 2.5, text: " ♪ Walk through the door ♪" },
        { start: 2.5, end: 4, text: "(upbeat music)" }, // dropped: non-lyrical
        { start: 4, end: 6.2, text: "oh oh oh" }, // dropped: filler
        { start: 6.2, end: 9, text: "seal this fate" },
      ],
    };
    expect(segmentsFromOpenAI(body)).toEqual([
      { start: 0, end: 2.5, text: "Walk through the door" },
      { start: 6.2, end: 9, text: "seal this fate" },
    ]);
  });
  it("tolerates a missing/!array segments field", () => {
    expect(segmentsFromOpenAI({})).toEqual([]);
    expect(segmentsFromOpenAI({ segments: "nope" })).toEqual([]);
    expect(segmentsFromOpenAI(null)).toEqual([]);
  });
  it("skips entries missing numeric times or text", () => {
    expect(
      segmentsFromOpenAI({
        segments: [{ start: 0, text: "no end" }, { start: 1, end: 2, text: 5 }],
      })
    ).toEqual([]);
  });
});

describe("cleanSegmentText", () => {
  it("strips music notes / non-speech markers and rejects filler", () => {
    expect(cleanSegmentText("♪ hello world ♪")).toBe("hello world");
    expect(cleanSegmentText("[BLANK_AUDIO]")).toBeNull();
    expect(cleanSegmentText("(applause)")).toBeNull();
    expect(cleanSegmentText("la la la")).toBeNull();
    expect(cleanSegmentText("   ")).toBeNull();
  });
});

describe("mainCluster", () => {
  it("drops an isolated early blip before a long gap, keeping the dominant run", () => {
    const segs = [
      { start: 0, end: 8, text: "we rise the text field" }, // early blip
      { start: 30, end: 37, text: "the email at-sign" },
      { start: 37, end: 44, text: "passwords guard the gate" },
      { start: 44, end: 49, text: "five five five" },
    ];
    expect(mainCluster(segs)).toEqual(segs.slice(1));
  });
  it("returns all segments when they're contiguous, and [] for none", () => {
    const segs = [
      { start: 1, end: 3, text: "a" },
      { start: 4, end: 6, text: "b" },
    ];
    expect(mainCluster(segs)).toEqual(segs);
    expect(mainCluster([])).toEqual([]);
  });
});

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

  it("drops bracketed ASR markers like [BLANK_AUDIO] and [Music]", () => {
    const srt = [
      "1",
      "00:05:04,300 --> 00:05:13,260",
      " [BLANK_AUDIO]",
      "",
      "2",
      "00:00:10,000 --> 00:00:12,000",
      " [Music] ",
      "",
      "3",
      "00:00:20,000 --> 00:00:22,000",
      "the real lyric here",
      "",
    ].join("\n");
    expect(parseWhisperSrt(srt)).toEqual([
      { start: 20, end: 22, text: "the real lyric here" },
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
