import { describe, expect, it } from "vitest";
import {
  alignLyricsToSegments,
  alignLyricsToWords,
  cleanSegmentText,
  estimateSyllables,
  layoutAlignedCues,
  mainCluster,
  mergeLrcWithWordOnsets,
  parseLrc,
  parseWhisperSrt,
  parseWhisperxJson,
  redistributeImplausibleCues,
  segmentsFromOpenAI,
  similarity,
  songStepOnsets,
  type TimedWord,
  tokenize,
  vocalRegion,
  vocalRegionExcludingTail,
  wordsFromOpenAI,
} from "./align.js";

// Build a flat word timeline from "word@start-end" shorthand for the tests.
function words(spec: string): TimedWord[] {
  return spec
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [word, span] = tok.split("@");
      const [start, end] = (span ?? "0-0").split("-").map(Number);
      return { word: word ?? "", start: start ?? 0, end: end ?? 0 };
    });
}

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
        segments: [
          { start: 0, text: "no end" },
          { start: 1, end: 2, text: 5 },
        ],
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
    expect(
      similarity("the text field cries", "the text field cries")
    ).toBeGreaterThan(0.9);
    // mondegreen still registers via bigrams
    expect(
      similarity(
        "the checkbook feels a sacred vow",
        "the checkbox seals our sacred vow"
      )
    ).toBeGreaterThan(0.4);
    expect(
      similarity("the select bends the world", "totally unrelated banana")
    ).toBeLessThan(0.15);
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
      {
        start: 35.0,
        end: 39.76,
        text: "The text field cries, the saga begins",
      },
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
      alignLyricsToSegments(
        ["alpha beta"],
        [{ start: 1, end: 2, text: "zulu yankee" }]
      )
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

describe("vocalRegionExcludingTail", () => {
  it("keeps from the first vocal to the last NOVEL line, dropping a looped tail", () => {
    // Three distinct lines, then the last one loops to fill the song. The region
    // must end just after the last novel line (12), not at the loop's end (90).
    const region = vocalRegionExcludingTail(
      [
        { start: 2, end: 6, text: "she opens up the login page" },
        { start: 6, end: 10, text: "typing out a password again" },
        { start: 10, end: 12, text: "the dashboard blooms in light" },
        { start: 12, end: 40, text: "the dashboard blooms in light" },
        { start: 40, end: 90, text: "the dashboard blooms in light" },
      ],
      { lead: 0, tail: 0 }
    );
    expect(region).toEqual({ start: 2, end: 12 });
  });

  it("keeps a chorus that repeats mid-song because novel verses still follow", () => {
    const region = vocalRegionExcludingTail(
      [
        { start: 0, end: 4, text: "verse one about the login" },
        { start: 4, end: 8, text: "chorus we ride again tonight" },
        { start: 8, end: 12, text: "verse two about the checkout" },
        { start: 12, end: 16, text: "chorus we ride again tonight" }, // repeat, mid-song
        { start: 16, end: 20, text: "verse three the final tests pass" }, // novel AFTER the repeat
      ],
      { lead: 0, tail: 0 }
    );
    // Ends at the last novel verse (20), not cut at the mid-song chorus repeat.
    expect(region?.end).toBe(20);
  });

  it("pads by lead/tail and clamps the start to 0", () => {
    expect(
      vocalRegionExcludingTail([{ start: 0.5, end: 2, text: "a line" }], {
        lead: 1.5,
        tail: 1.5,
      })
    ).toEqual({ start: 0, end: 3.5 });
  });

  it("returns null for no segments (caller falls back to the raw cluster)", () => {
    expect(vocalRegionExcludingTail([])).toBeNull();
  });
});

describe("tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenize("The Text-Field, cries!")).toEqual([
      "the",
      "text",
      "field",
      "cries",
    ]);
  });
});

describe("alignLyricsToWords", () => {
  it("distributes a mashed transcript back across lyric lines via the word stream", () => {
    // The transcriber merged three sung lines into one blob at the segment level;
    // the word stream still carries them in order, so each line gets its own span.
    const lines = [
      "She opens the page",
      "She types the key",
      "Green lights are shining",
    ];
    const w = words(
      "she@1-1.2 opens@1.3-1.8 the@1.9-2 page@2.1-2.6 " +
        "she@3-3.2 types@3.3-3.8 the@3.9-4 key@4.1-4.6 " +
        "green@5-5.4 lights@5.5-6 are@6.1-6.2 shining@6.3-6.9"
    );
    const aligned = alignLyricsToWords(lines, w);
    expect(aligned.map((a) => [a.index, a.support > 0.5])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    // Start is the first CONTENT word ("opens"@1.3) — "she" is a skipped stopword.
    expect(aligned[0]?.start).toBeCloseTo(1.3, 1);
    expect(aligned[0]?.end).toBeCloseTo(2.6, 1);
    expect(aligned[2]?.start).toBeCloseTo(5, 1);
  });

  it("marks an unsung line (no matching words) with support 0 and null timing", () => {
    const lines = [
      "She opens the page",
      "The login waits alone",
      "Green lights shining",
    ];
    // The middle line is never sung.
    const w = words(
      "she@1-1.2 opens@1.3-1.8 page@2.1-2.6 green@5-5.4 lights@5.5-6 shining@6.3-6.9"
    );
    const aligned = alignLyricsToWords(lines, w);
    expect(aligned[1]?.start).toBeNull();
    expect(aligned[1]?.support).toBe(0);
    expect(aligned[0]?.support).toBeGreaterThan(0.5);
    expect(aligned[2]?.support).toBeGreaterThan(0.5);
  });

  it("does not let a repeated function word leap the pointer past a sung line", () => {
    // A garbled repeat ("the ... the ...") between lines must not strand line 2.
    const lines = ["Fields all fill", "She saves the file"];
    const w = words(
      "fields@1-1.4 fill@1.6-2 the@2.2-2.4 the@2.5-2.7 she@3-3.2 saves@3.3-3.9 file@4-4.5"
    );
    const aligned = alignLyricsToWords(lines, w);
    expect(aligned[0]?.support).toBeGreaterThan(0.5);
    expect(aligned[1]?.support).toBeGreaterThan(0.5); // not stranded
    // "she" is a stopword; the line anchors on "saves"@3.3.
    expect(aligned[1]?.start).toBeCloseTo(3.3, 1);
  });

  it("drops low-confidence (hallucinated) words before aligning", () => {
    const lines = ["Green lights are shining"];
    const w: TimedWord[] = [
      { word: "thanks", start: 0, end: 0.5, prob: 0.05 }, // hallucination
      { word: "green", start: 5, end: 5.4, prob: 0.9 },
      { word: "lights", start: 5.5, end: 6, prob: 0.9 },
      { word: "shining", start: 6.3, end: 6.9, prob: 0.9 },
    ];
    const aligned = alignLyricsToWords(lines, w, { minProb: 0.3 });
    expect(aligned[0]?.start).toBeCloseTo(5, 1); // starts at "green", not "thanks"
  });
});

describe("layoutAlignedCues", () => {
  it("keeps matched lines and drops unsung ones whose gap is too short", () => {
    const aligned = [
      { index: 0, start: 1, end: 3, text: "line one here", support: 1 },
      {
        index: 1,
        start: null,
        end: null,
        text: "skipped line two",
        support: 0,
      },
      { index: 2, start: 3.2, end: 5, text: "line three here", support: 1 },
    ];
    const cues = layoutAlignedCues(aligned, { regionStart: 0, regionEnd: 8 });
    // The skipped middle line (0.2s gap) is dropped, not interpolated.
    expect(cues.map((c) => c.text)).toEqual([
      "line one here",
      "line three here",
    ]);
  });

  it("interpolates an unsung line when the gap is long enough to hold it", () => {
    const aligned = [
      { index: 0, start: 1, end: 3, text: "line one", support: 1 },
      {
        index: 1,
        start: null,
        end: null,
        text: "middle sung but garbled",
        support: 0,
      },
      { index: 2, start: 12, end: 14, text: "line three", support: 1 },
    ];
    const cues = layoutAlignedCues(aligned, { regionStart: 0, regionEnd: 16 });
    expect(cues.map((c) => c.text)).toContain("middle sung but garbled");
    const mid = cues.find((c) => c.text === "middle sung but garbled");
    expect(mid?.start).toBeGreaterThanOrEqual(3);
    expect(mid?.end).toBeLessThanOrEqual(12);
  });

  it("de-overlaps and clamps to the region", () => {
    const aligned = [
      { index: 0, start: 1, end: 9, text: "long one", support: 1 },
      { index: 1, start: 4, end: 6, text: "two", support: 1 },
    ];
    const cues = layoutAlignedCues(aligned, { regionStart: 0, regionEnd: 10 });
    // First cue ends by the second's start.
    expect(cues[0]?.end).toBeLessThanOrEqual(cues[1]?.start ?? 0);
    for (const c of cues) {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(10);
    }
  });
});

describe("estimateSyllables", () => {
  it("counts vowel groups with a floor of one per word", () => {
    expect(estimateSyllables("green lights shining")).toBe(4); // green, lights, shin-ing
    expect(estimateSyllables("go")).toBe(1);
    expect(estimateSyllables("")).toBe(1);
  });
});

describe("parseWhisperxJson", () => {
  it("extracts segments and the per-word timeline", () => {
    const { segments, words: w } = parseWhisperxJson({
      segments: [
        {
          start: 1,
          end: 3,
          text: "Green lights",
          words: [
            { word: "Green", start: 1, end: 1.5, score: 0.9 },
            { word: "lights", start: 1.6, end: 2.2, score: 0.8 },
            { word: "123", score: 0.5 }, // no start/end → dropped
          ],
        },
      ],
    });
    expect(segments).toEqual([{ start: 1, end: 3, text: "Green lights" }]);
    expect(w).toEqual([
      { word: "Green", start: 1, end: 1.5, prob: 0.9 },
      { word: "lights", start: 1.6, end: 2.2, prob: 0.8 },
    ]);
  });
  it("tolerates missing segments", () => {
    expect(parseWhisperxJson({})).toEqual({ segments: [], words: [] });
  });
});

describe("wordsFromOpenAI", () => {
  it("maps a verbose_json words array to TimedWord[]", () => {
    expect(
      wordsFromOpenAI({
        words: [
          { word: "hello", start: 0.1, end: 0.5 },
          { word: "", start: 0.6, end: 0.8 }, // empty → dropped
          { word: "world", start: 0.9, end: 1.3 },
        ],
      })
    ).toEqual([
      { word: "hello", start: 0.1, end: 0.5 },
      { word: "world", start: 0.9, end: 1.3 },
    ]);
  });
  it("returns [] when there is no words array", () => {
    expect(wordsFromOpenAI({ segments: [] })).toEqual([]);
  });
});

describe("parseLrc", () => {
  it("parses [mm:ss.xx] lines into timed segments (end = next start)", () => {
    const lrc = [
      "[ti:My Song]", // metadata → no timestamp → dropped
      "[00:05.00]She opens up the page",
      "[00:09.50]Green lights are shining",
      "[00:14.00]The tests all pass",
    ].join("\n");
    expect(parseLrc(lrc)).toEqual([
      { start: 5, end: 9.5, text: "She opens up the page" },
      { start: 9.5, end: 14, text: "Green lights are shining" },
      { start: 14, end: 18, text: "The tests all pass" }, // last → +tailSec(4)
    ]);
  });

  it("drops structure-tag / filler lines and handles multiple tags per line", () => {
    const lrc = [
      "[00:02.00][verse]", // becomes "[verse]" → cleaned to empty → dropped
      "[00:03.00]la la la", // filler → dropped
      "[00:04.00][00:20.00]Real words here", // two tags, same text
    ].join("\n");
    expect(parseLrc(lrc)).toEqual([
      { start: 4, end: 20, text: "Real words here" },
      { start: 20, end: 24, text: "Real words here" },
    ]);
  });

  it("returns [] for empty / tagless input", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("just prose, no timestamps")).toEqual([]);
  });
});

describe("mergeLrcWithWordOnsets", () => {
  const lines = ["Line one here", "Line two here", "Line three here"];
  it("floors an LRC start by the word onset (no early reveal), keeps LRC end", () => {
    const lrc = [
      { start: 0.2, end: 18, text: "Line one here" }, // LRC placed it at the intro
      { start: 18, end: 26, text: "Line two here" },
      { start: 26, end: 30, text: "Line three here" },
    ];
    const wordAligned = [
      { index: 0, start: 9.7, end: 12, text: "Line one here", support: 1 }, // heard at 9.7
      { index: 1, start: null, end: null, text: "Line two here", support: 0 }, // word missed it
      { index: 2, start: 26.1, end: 28, text: "Line three here", support: 1 },
    ];
    const merged = mergeLrcWithWordOnsets(lines, lrc, wordAligned);
    expect(merged[0]?.start).toBe(9.7); // pushed later to the heard onset
    expect(merged[0]?.end).toBe(18); // LRC end kept
    expect(merged[1]?.start).toBe(18); // word missed it → LRC start kept
    expect(merged[2]?.start).toBe(26.1); // onset later than LRC → floored up slightly
  });

  it("never pulls a start earlier than the LRC and marks unsung lines null", () => {
    const lrc = [{ start: 10, end: 14, text: "Line one here" }];
    const wordAligned = [
      { index: 0, start: 5, end: 8, text: "Line one here", support: 1 }, // onset EARLIER
    ];
    const merged = mergeLrcWithWordOnsets(lines, lrc, wordAligned);
    expect(merged[0]?.start).toBe(10); // max(10, 5) — never earlier than LRC
    expect(merged[1]?.start).toBeNull(); // not in LRC → unsung
    expect(merged[2]?.start).toBeNull();
  });
});

describe("songStepOnsets", () => {
  it("distributes group windows across steps and interpolates unsung groups", () => {
    // 3 groups over steps [[0,1],[2],[3]]; middle group's line wasn't sung (null).
    const onsets = songStepOnsets([[0, 1], [2], [3]], [2, null, 20], 30);
    // g0 [2,11) split across 2 steps -> 2, 6.5; g1 interpolated to 11; g2 at 20.
    expect(onsets).toEqual([2, 6.5, 11, 20]);
  });
  it("is non-decreasing and covers every step index", () => {
    const onsets = songStepOnsets([[0], [1], [2]], [10, 4, 8], 40); // out-of-order starts
    expect(onsets.length).toBe(3);
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i]).toBeGreaterThanOrEqual(onsets[i - 1] ?? 0);
    }
  });
});

describe("redistributeImplausibleCues", () => {
  it("caps the gap so a line flung to the tail is pulled back to a normal cadence", () => {
    // The v4 failure shape: a few lines early, then one stamped at 112s. The bogus
    // 104s jump is collapsed to one cadence (~5s), bounding the body to real content.
    const cues = [
      { start: 2, end: 6, text: "one" },
      { start: 5, end: 8, text: "two" },
      { start: 8, end: 11, text: "three" },
      { start: 112, end: 114, text: "four" },
    ];
    const out = redistributeImplausibleCues(cues, 40);
    expect(out.map((c) => Math.round(c.start))).toEqual([2, 5, 8, 13]);
    expect(out.map((c) => c.text)).toEqual(["one", "two", "three", "four"]);
  });
  it("is a no-op on an evenly-timed take inside the vocal region", () => {
    const cues = [
      { start: 2, end: 6, text: "a" },
      { start: 6, end: 10, text: "b" },
      { start: 10, end: 14, text: "c" },
    ];
    expect(redistributeImplausibleCues(cues, 40)).toEqual(cues);
  });
});
