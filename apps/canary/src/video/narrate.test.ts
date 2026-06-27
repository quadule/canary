import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAudioMix,
  buildLyricsPrompt,
  buildNarrationPrompt,
  buildSrt,
  captionLineMax,
  buildModelCredits,
  changeScaleHint,
  customSaySynth,
  layoutSongCues,
  songHoldSec,
  extractCaptions,
  lyricsPathFor,
  parseFilterNames,
  parseLyricsJson,
  precinematicVideoPath,
  sayCommand,
  voiceCredit,
  parseInstalledVoices,
  parseNarrationJson,
  pickVoice,
  planRetime,
  secToSrtTimestamp,
  titleStyle,
  wrapCaption,
  wrapTitle,
} from "./narrate.js";

describe("secToSrtTimestamp", () => {
  it("formats zero as 00:00:00,000", () => {
    expect(secToSrtTimestamp(0)).toBe("00:00:00,000");
  });

  it("formats sub-second values with zero-padded milliseconds", () => {
    expect(secToSrtTimestamp(2.5)).toBe("00:00:02,500");
    expect(secToSrtTimestamp(0.07)).toBe("00:00:00,070");
    expect(secToSrtTimestamp(0.004)).toBe("00:00:00,004");
  });

  it("rolls minutes and seconds over correctly", () => {
    expect(secToSrtTimestamp(61.2)).toBe("00:01:01,200");
    expect(secToSrtTimestamp(125)).toBe("00:02:05,000");
  });

  it("handles values past one hour", () => {
    expect(secToSrtTimestamp(3661.123)).toBe("01:01:01,123");
  });

  it("clamps negatives to zero", () => {
    expect(secToSrtTimestamp(-5)).toBe("00:00:00,000");
  });
});

describe("buildSrt", () => {
  it("numbers cues from 1 and emits start/end/text blocks", () => {
    const srt = buildSrt([
      { start: 2.5, end: 6.2, text: "Our operative approaches." },
      { start: 6.2, end: 9, text: "The credentials are entered." },
    ]);
    expect(srt).toBe(
      "1\n00:00:02,500 --> 00:00:06,200\nOur operative approaches.\n\n" +
        "2\n00:00:06,200 --> 00:00:09,000\nThe credentials are entered.\n"
    );
  });

  it("returns an empty string for no cues", () => {
    expect(buildSrt([])).toBe("");
  });
});

describe("buildAudioMix", () => {
  it("returns an empty string for zero tracks", () => {
    expect(buildAudioMix([])).toBe("");
  });

  it("wires a single full-volume track at index 1 into amix", () => {
    expect(buildAudioMix([{ delayMs: 2500 }])).toBe(
      "[1:a]adelay=2500|2500[a0];[a0]amix=inputs=1:normalize=0:dropout_transition=0[aout]"
    );
  });

  it("delays narration tracks and scales a music bed's volume", () => {
    expect(
      buildAudioMix([
        { delayMs: 0 },
        { delayMs: 3500 },
        { delayMs: 0, volume: 0.16 },
      ])
    ).toBe(
      "[1:a]adelay=0|0[a0];" +
        "[2:a]adelay=3500|3500[a1];" +
        "[3:a]adelay=0|0,volume=0.160[a2];" +
        "[a0][a1][a2]amix=inputs=3:normalize=0:dropout_transition=0[aout]"
    );
  });
});

describe("parseNarrationJson", () => {
  const valid =
    '{"title":"THE CAPER","steps":[{"index":0,"narration":"He approaches."}]}';

  it("parses clean JSON", () => {
    expect(parseNarrationJson(valid)).toEqual({
      title: "THE CAPER",
      steps: [{ index: 0, narration: "He approaches." }],
    });
  });

  const fence = "```";

  it("strips ```json fences before parsing", () => {
    expect(parseNarrationJson(`${fence}json\n${valid}\n${fence}`)).toEqual({
      title: "THE CAPER",
      steps: [{ index: 0, narration: "He approaches." }],
    });
  });

  it("strips bare ``` fences", () => {
    expect(parseNarrationJson(`${fence}\n${valid}\n${fence}`)).not.toBeNull();
  });

  it("recovers JSON from a chatty preamble (first { to last })", () => {
    expect(
      parseNarrationJson(
        `Sure! Here is the narration:\n${valid}\nHope it helps!`
      )
    ).toEqual({
      title: "THE CAPER",
      steps: [{ index: 0, narration: "He approaches." }],
    });
  });

  it("strips libass override tags from narration", () => {
    const parsed = parseNarrationJson(
      '{"title":"X","steps":[{"index":0,"narration":"{\\\\pos(9,9)}sneaky {\\\\fs99}text"}]}'
    );
    expect(parsed?.steps[0]?.narration).toBe("sneaky text");
  });

  it("returns null on garbage", () => {
    expect(parseNarrationJson("not json at all")).toBeNull();
    expect(parseNarrationJson("")).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    expect(parseNarrationJson('{"title":"x"}')).toBeNull();
    expect(parseNarrationJson('{"steps":[]}')).toBeNull();
    expect(parseNarrationJson('{"title":42,"steps":[]}')).toBeNull();
    expect(
      parseNarrationJson(
        '{"title":"x","steps":[{"index":"0","narration":"y"}]}'
      )
    ).toBeNull();
    expect(
      parseNarrationJson('{"title":"x","steps":[{"index":0}]}')
    ).toBeNull();
    expect(parseNarrationJson("[]")).toBeNull();
    expect(parseNarrationJson("null")).toBeNull();
  });
});

describe("buildNarrationPrompt", () => {
  const steps = [
    { index: 0, name: "Open the login page", script: "page.open('/login')" },
    { index: 1, name: "Fill the password field" },
  ];

  it("embeds the creative direction and every step name", () => {
    const prompt = buildNarrationPrompt({
      direction: "1970s heist thriller, narrated as a limerick",
      steps,
    });
    expect(prompt).toContain(
      "Creative direction: 1970s heist thriller, narrated as a limerick"
    );
    expect(prompt).toContain("Open the login page");
    expect(prompt).toContain("Fill the password field");
  });

  it("demands strict JSON output", () => {
    const prompt = buildNarrationPrompt({
      direction: "nature documentary",
      steps,
    });
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain('"title"');
  });

  it("includes a step's script slice when present", () => {
    const prompt = buildNarrationPrompt({
      direction: "noir",
      steps,
    });
    expect(prompt).toContain("page.open('/login')");
  });

  it("surfaces showCaption text as an intent note, even past the slice", () => {
    // The caption sits far beyond SCRIPT_SLICE_CHARS (200) so the script slice
    // alone would drop it — extractCaptions reads the full script.
    const pad = "// filler ".repeat(40);
    const prompt = buildNarrationPrompt({
      direction: "noir",
      steps: [
        {
          index: 0,
          name: "Submit the form",
          script: `${pad}\nawait page.showCaption("Verifying the discount applies");`,
        },
      ],
    });
    expect(prompt).toContain('intent: "Verifying the discount applies"');
  });

  it("embeds the change scale as a SECONDARY cue when provided", () => {
    const withChange = buildNarrationPrompt({
      direction: "noir",
      change: {
        label: "45 commits, 71 files, +7386/-402",
        scaleHint: "large — go expansive",
      },
      steps,
    });
    expect(withChange).toContain("change under review is 45 commits");
    expect(withChange).toContain("SECONDARY");
    expect(withChange).toContain("go expansive");
    const without = buildNarrationPrompt({ direction: "noir", steps });
    expect(without).not.toContain("change under review");
  });
});

describe("precinematicVideoPath", () => {
  it("inserts .precinematic before the extension", () => {
    expect(precinematicVideoPath("/s/abc/video.webm")).toBe(
      "/s/abc/video.precinematic.webm"
    );
    expect(precinematicVideoPath("/s/abc/clip.mp4")).toBe(
      "/s/abc/clip.precinematic.mp4"
    );
  });
});

describe("songHoldSec", () => {
  it("floors short lines and scales with word count", () => {
    expect(songHoldSec("two words")).toBe(3.5); // floor
    expect(songHoldSec("")).toBe(3.5);
    // 10 words → 10/2.5 + 1 = 5s
    expect(songHoldSec("one two three four five six seven eight nine ten")).toBe(5);
  });
  it("caps very long lines", () => {
    expect(songHoldSec(Array.from({ length: 40 }, () => "x").join(" "))).toBe(6.5);
  });
});

describe("layoutSongCues", () => {
  it("leaves well-spread lines at their natural times", () => {
    const cues = layoutSongCues(
      [
        { start: 2, text: "a" },
        { start: 6, text: "b" },
        { start: 10, text: "c" },
      ],
      30
    );
    expect(cues.map((c) => c.start)).toEqual([2, 6, 10]);
    // Non-last hold to the next start; last gets the tail (3s default).
    expect(cues[0]?.end).toBe(6);
    expect(cues[2]?.end).toBe(13);
  });

  it("pushes bunched lines apart so they never overlap", () => {
    const cues = layoutSongCues(
      [
        { start: 2, text: "a" },
        { start: 9, text: "b" },
        { start: 9.1, text: "c" },
        { start: 9.2, text: "d" },
      ],
      40,
      { minDurSec: 1.4 }
    );
    // Each cue starts at or after the previous end — no overlap.
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]?.start).toBeGreaterThanOrEqual(cues[i - 1]?.end ?? 0);
    }
    // The bunched trio is spaced by the minimum display duration.
    expect(cues[2]?.start).toBeCloseTo(10.4, 5);
    expect(cues[3]?.start).toBeCloseTo(11.8, 5);
  });

  it("clamps to the video end and drops lines with no room left", () => {
    const cues = layoutSongCues(
      [
        { start: 1, text: "a" },
        { start: 1.1, text: "b" },
        { start: 1.2, text: "c" },
      ],
      3,
      { minDurSec: 1.4, tailSec: 3 }
    );
    expect(cues.every((c) => c.end <= 3)).toBe(true);
    // Only the lines that fit before the 3s end survive.
    expect(cues.length).toBeLessThan(3);
  });
});

describe("lyricsPathFor", () => {
  it("swaps the video extension for .lyrics.txt", () => {
    expect(lyricsPathFor("/s/abc/video.webm")).toBe("/s/abc/video.lyrics.txt");
    expect(lyricsPathFor("/s/abc/clip.mp4")).toBe("/s/abc/clip.lyrics.txt");
  });
});

describe("sayCommand", () => {
  it("defaults to `say` and honors $CANARY_SAY_COMMAND", () => {
    expect(sayCommand({})).toBe("say");
    expect(sayCommand({ CANARY_SAY_COMMAND: "/usr/local/bin/mysay" })).toBe(
      "/usr/local/bin/mysay"
    );
    expect(sayCommand({ CANARY_SAY_COMMAND: "  " })).toBe("say");
  });
});

describe("customSaySynth", () => {
  it("passes the text as the only arg and writes to $CANARY_SAY_OUTPUT", async () => {
    // A stand-in TTS command: it carries its own arg, reads the text from "$1",
    // and writes to the env-provided output path — exactly the custom contract.
    const synth = customSaySynth(
      'printf "%s" "$1" > "$CANARY_SAY_OUTPUT" # --some-flag'
    );
    const out = path.join(
      os.tmpdir(),
      `canary-customsay-${process.pid}.txt`
    );
    try {
      await synth.run("hello from canary", out);
      expect(readFileSync(out, "utf8")).toBe("hello from canary");
    } finally {
      rmSync(out, { force: true });
    }
  });
});

describe("voiceCredit", () => {
  it("formats the oMLX, Gemini, and say/custom cases", () => {
    expect(voiceCredit("omlx-tts", "omlx:Qwen3-TTS")).toBe(
      "Voice — oMLX Qwen3-TTS"
    );
    expect(voiceCredit("gemini-tts", "gemini:Charon")).toBe(
      "Voice — Charon (Google Gemini)"
    );
    expect(voiceCredit(undefined, "Ava (Premium)")).toBe(
      "Voice — Ava (Premium)"
    );
    expect(voiceCredit(undefined, "")).toBe("Voice — system speech");
  });
});

describe("buildModelCredits", () => {
  it("always credits narration, then voice, then any music/title art used", () => {
    expect(
      buildModelCredits({
        voiceLabel: "omlx:M",
        ttsId: "omlx-tts",
        musicId: "archive-music",
        titleArt: true,
      })
    ).toEqual([
      "Narration — Claude (Anthropic)",
      "Voice — oMLX M",
      "Music — archive.org (Creative Commons)",
      "Title art — Nano Banana (Google Gemini)",
    ]);
  });

  it("omits music and title art when none were used", () => {
    expect(
      buildModelCredits({
        voiceLabel: "Samantha",
        ttsId: undefined,
        musicId: undefined,
        titleArt: false,
      })
    ).toEqual(["Narration — Claude (Anthropic)", "Voice — Samantha"]);
  });

  it("credits lyrics (not narration) and drops the voice line in song mode", () => {
    expect(
      buildModelCredits({
        voiceLabel: "ignored",
        ttsId: "omlx-tts",
        musicId: "acestep-music",
        titleArt: false,
        song: true,
      })
    ).toEqual([
      "Lyrics — Claude (Anthropic)",
      "Music — ACE-Step 1.5 (local)",
    ]);
  });
});

describe("parseLyricsJson", () => {
  it("parses {title, steps:[{index, lyric}]} into ordered lines", () => {
    const raw =
      '{"title":"THE BUILD","steps":[{"index":0,"lyric":"we open the door"},{"index":1,"lyric":"we ship it green"}]}';
    expect(parseLyricsJson(raw)).toEqual({
      title: "THE BUILD",
      lines: [
        { index: 0, text: "we open the door" },
        { index: 1, text: "we ship it green" },
      ],
    });
  });

  it("strips code fences, tolerates a preamble, and drops blank lines", () => {
    const fence = "```";
    const body =
      '{"title":"X","steps":[{"index":0,"lyric":"la"},{"index":1,"lyric":"  "}]}';
    expect(parseLyricsJson(`${fence}json\n${body}\n${fence}`)).toEqual({
      title: "X",
      lines: [{ index: 0, text: "la" }],
    });
    expect(parseLyricsJson(`Here you go: ${body}`)).toEqual({
      title: "X",
      lines: [{ index: 0, text: "la" }],
    });
  });

  it("rejects a bad title, a missing/empty steps array, or malformed entries", () => {
    expect(parseLyricsJson('{"title":"x"}')).toBeNull();
    expect(parseLyricsJson('{"steps":[{"index":0,"lyric":"a"}]}')).toBeNull();
    expect(parseLyricsJson('{"title":"","steps":[{"index":0,"lyric":"a"}]}')).toBeNull();
    // All lines blank → no usable line survives.
    expect(parseLyricsJson('{"title":"x","steps":[{"index":0,"lyric":"  "}]}')).toBeNull();
    expect(parseLyricsJson('{"title":"x","steps":[{"index":0}]}')).toBeNull();
    expect(parseLyricsJson('{"title":"x","steps":"nope"}')).toBeNull();
    expect(parseLyricsJson("not json")).toBeNull();
    expect(parseLyricsJson("")).toBeNull();
  });
});

describe("buildLyricsPrompt", () => {
  it("asks for one line per step, scaled to length, as strict per-step JSON", () => {
    const prompt = buildLyricsPrompt({
      direction: "80s power ballad",
      videoSeconds: 12,
      steps: [
        { index: 0, name: "open", script: "await page.goto('/')" },
        { index: 1, name: "login" },
      ],
    });
    expect(prompt).toContain("80s power ballad");
    expect(prompt).toContain(
      '{"title": string, "steps": [{"index": number, "lyric": string}]}'
    );
    // One line per step, count called out.
    expect(prompt).toContain("2 lines total");
    expect(prompt).toContain("0. open");
    expect(prompt).toContain("1. login");
    // Scales to the runtime.
    expect(prompt).toContain("12 seconds");
    // No spoken narration in song mode.
    expect(prompt).toContain("there is no spoken narration");
  });
});

describe("extractCaptions", () => {
  it("returns [] for empty or caption-free scripts", () => {
    expect(extractCaptions(undefined)).toEqual([]);
    expect(extractCaptions("await page.humanClick('#go')")).toEqual([]);
  });

  it("pulls text from every showCaption call, across quote styles", () => {
    const script = [
      `await page.showCaption("double quoted");`,
      `await page.showCaption('single quoted');`,
      "await page.showCaption(`template literal`);",
    ].join("\n");
    expect(extractCaptions(script)).toEqual([
      "double quoted",
      "single quoted",
      "template literal",
    ]);
  });

  it("unescapes embedded quotes and ignores the durationMs option", () => {
    const script = `await page.showCaption("she said \\"hi\\"", { durationMs: 5000 });`;
    expect(extractCaptions(script)).toEqual(['she said "hi"']);
  });
});

describe("wrapTitle", () => {
  it("greedily word-wraps to the char limit", () => {
    expect(wrapTitle("THE GREAT PULL REQUEST CAPER", 12)).toEqual([
      "THE GREAT",
      "PULL REQUEST",
      "CAPER",
    ]);
  });

  it("honors explicit newlines as forced breaks", () => {
    expect(wrapTitle("ACT ONE\nThe Setup", 100)).toEqual([
      "ACT ONE",
      "The Setup",
    ]);
  });

  it("keeps an over-long single word whole", () => {
    expect(wrapTitle("SUPERCALIFRAGILISTIC", 8)).toEqual([
      "SUPERCALIFRAGILISTIC",
    ]);
  });

  it("never returns an empty array", () => {
    expect(wrapTitle("", 10)).toEqual([""]);
  });
});

describe("wrapCaption", () => {
  it("leaves a short caption on a single line", () => {
    expect(wrapCaption("Our operative approaches.", 48)).toBe(
      "Our operative approaches."
    );
  });

  it("wraps a longer caption onto two lines", () => {
    const out = wrapCaption(
      "The operative enters the stolen credentials and waits for the redirect.",
      30,
      2
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(31); // 30 + room for the ellipsis
    }
  });

  it("truncates with an ellipsis when it would exceed two lines", () => {
    const out = wrapCaption(
      "This narration is far too long to ever fit within a mere two short caption lines on screen.",
      20,
      2
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(out.endsWith("…")).toBe(true);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("returns an empty string for blank input", () => {
    expect(wrapCaption("   ", 48)).toBe("");
  });
});

describe("captionLineMax", () => {
  it("gives the full budget at the 1280px default and scales down when narrow", () => {
    expect(captionLineMax(1280)).toBe(48);
    expect(captionLineMax(800)).toBe(30);
  });

  it("caps wide videos and floors tiny ones", () => {
    expect(captionLineMax(1920)).toBe(48); // capped at CAPTION_LINE_MAX
    expect(captionLineMax(320)).toBe(24); // floored
  });

  it("falls back to the default budget when width is unknown", () => {
    expect(captionLineMax(undefined)).toBe(48);
    expect(captionLineMax(0)).toBe(48);
  });
});

describe("changeScaleHint", () => {
  it("sizes by length/energy without imposing a format", () => {
    expect(changeScaleHint(1, 10)).toContain("very small");
    expect(changeScaleHint(45, 7788)).toContain("large");
    // Format-agnostic: never names a film/trailer that could fight the theme.
    expect(changeScaleHint(45, 7788)).not.toMatch(/film|trailer|epic movie/);
  });

  it("scales through the middle tiers", () => {
    expect(changeScaleHint(2, 200)).toContain("small");
    expect(changeScaleHint(7, 600)).toContain("medium");
  });
});

describe("titleStyle", () => {
  it("maps categories to accent colors (white default)", () => {
    expect(titleStyle(undefined).color).toBe("white");
    expect(titleStyle("commercial").color).toBe("0xFFD400");
  });

  it("resolves font to an installed file or undefined (cross-platform)", () => {
    const font = titleStyle("movie").font;
    expect(font === undefined || existsSync(font)).toBe(true);
  });
});

describe("parseInstalledVoices", () => {
  it("keeps the full `-v` name, quality tag, and locale per line", () => {
    const stdout = [
      "Ava (Premium)       en_US    # Hello! My name is Ava.",
      "Samantha            en_US    # Hello! My name is Samantha.",
      "Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.",
    ].join("\n");
    const voices = parseInstalledVoices(stdout);

    const ava = voices.find((v) => v.name === "Ava");
    // The "(Premium)" suffix IS part of the usable -v name — passing the bare
    // name selects the compact variant.
    expect(ava?.full).toBe("Ava (Premium)");
    expect(ava?.quality).toBe("Premium");
    expect(ava?.locale).toBe("en_US");

    const samantha = voices.find((v) => v.name === "Samantha");
    expect(samantha?.full).toBe("Samantha");
    expect(samantha?.quality).toBe("Default");

    const daniel = voices.find((v) => v.name === "Daniel");
    expect(daniel?.full).toBe("Daniel (Enhanced)");
    expect(daniel?.quality).toBe("Enhanced");
    expect(daniel?.locale).toBe("en_GB");
  });

  it("ignores blank lines and returns an empty array for empty input", () => {
    expect(parseInstalledVoices("")).toEqual([]);
    expect(parseInstalledVoices("\n\n  \n")).toEqual([]);
  });
});

describe("pickVoice", () => {
  const original = process.env.CANARY_SAY_VOICE;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.CANARY_SAY_VOICE;
    } else {
      process.env.CANARY_SAY_VOICE = original;
    }
  });

  const parse = (lines: string[]) => parseInstalledVoices(lines.join("\n"));

  it("never picks a robotic base voice when a premium one is installed", () => {
    delete process.env.CANARY_SAY_VOICE;
    const voices = parse([
      "Ava (Premium)       en_US    # Hello!",
      "Samantha            en_US    # Hello!",
    ]);
    // Only one premium voice, so the pick is deterministic regardless of random.
    for (let i = 0; i < 10; i++) {
      expect(pickVoice(voices)).toBe("Ava (Premium)");
    }
  });

  it("prefers Premium over Enhanced, US English over other English", () => {
    delete process.env.CANARY_SAY_VOICE;
    const voices = parse([
      "Daniel (Enhanced)   en_GB    # Hello!",
      "Serena (Premium)    en_GB    # Hello!",
      "Ava (Premium)       en_US    # Hello!",
    ]);
    for (let i = 0; i < 10; i++) {
      expect(pickVoice(voices)).toBe("Ava (Premium)");
    }
  });

  it("falls through to an enhanced voice when no premium exists", () => {
    delete process.env.CANARY_SAY_VOICE;
    const voices = parse([
      "Daniel (Enhanced)   en_US    # Hello!",
      "Samantha            en_US    # Hello!",
    ]);
    expect(pickVoice(voices)).toBe("Daniel (Enhanced)");
  });

  it("honors an explicit $CANARY_SAY_VOICE override", () => {
    process.env.CANARY_SAY_VOICE = "Karen (Premium)";
    expect(pickVoice(parse(["Ava (Premium)  en_US  # Hi"]))).toBe(
      "Karen (Premium)"
    );
  });

  it("falls back to Samantha when nothing is installed", () => {
    delete process.env.CANARY_SAY_VOICE;
    expect(pickVoice([])).toBe("Samantha");
  });
});

describe("parseFilterNames", () => {
  it("extracts filter names from `ffmpeg -filters` rows", () => {
    const stdout = [
      "Filters:",
      "  T. adelay            A->A       Delay one or more audio channels.",
      "  .. amix              N->A       Audio mixing.",
      "  T. drawtext          V->V       Draw text on top of video frames.",
      "  .. concat            N->N       Concatenate audio and video streams.",
    ].join("\n");
    const names = parseFilterNames(stdout);
    expect(names.has("adelay")).toBe(true);
    expect(names.has("amix")).toBe(true);
    expect(names.has("drawtext")).toBe(true);
    expect(names.has("concat")).toBe(true);
  });

  it("omits filters absent from a minimal build", () => {
    const stdout = [
      "  T. adelay            A->A       Delay one or more audio channels.",
      "  .. amix              N->A       Audio mixing.",
    ].join("\n");
    const names = parseFilterNames(stdout);
    expect(names.has("drawtext")).toBe(false);
    expect(names.has("subtitles")).toBe(false);
  });

  it("ignores header and legend lines without an I/O column", () => {
    expect(parseFilterNames("Filters:\n  Legend without arrows\n").size).toBe(
      0
    );
  });
});

describe("planRetime", () => {
  it("freezes a step whose narration outruns its footage, and shifts later steps", () => {
    // Two steps 3s apart in an 8s video; narration is 12s and 11s.
    const plan = planRetime({
      stepTimes: [1, 4],
      clipDurSec: [12, 11],
      totalSec: 8,
    });
    expect(plan.leadSec).toBe(1); // [0,1) preserved before the first step
    // footage: step0 = 4-1 = 3, step1 = 8-4 = 4
    expect(plan.footage).toEqual([3, 4]);
    // hold = max(0, dur - footage): 12-3=9, 11-4=7
    expect(plan.holds).toEqual([9, 7]);
    // starts: step0 begins after the lead; step1 after step0's full slot (3+9)
    expect(plan.starts).toEqual([1, 1 + 3 + 9]);
    // each slot is long enough for its narration (no overlap)
    const [start0 = 0, start1 = 0] = plan.starts;
    expect(start1 - start0).toBeGreaterThanOrEqual(12);
  });

  it("adds no hold when footage already covers the narration", () => {
    const plan = planRetime({
      stepTimes: [0, 5],
      clipDurSec: [2, 1],
      totalSec: 10,
    });
    expect(plan.holds).toEqual([0, 0]);
    expect(plan.starts).toEqual([0, 5]);
  });

  it("handles a step with no narration (zero duration)", () => {
    const plan = planRetime({
      stepTimes: [1, 4],
      clipDurSec: [0, 6],
      totalSec: 8,
    });
    expect(plan.holds[0]).toBe(0);
    expect(plan.holds[1]).toBe(2); // 6 - (8-4)=2
  });
});
