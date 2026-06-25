import { describe, expect, it } from "vitest";
import {
  buildAdelayMix,
  buildNarrationPrompt,
  buildSrt,
  parseFilterNames,
  parseInstalledVoiceNames,
  parseNarrationJson,
  planRetime,
  secToSrtTimestamp,
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

describe("buildAdelayMix", () => {
  it("returns an empty string for zero inputs", () => {
    expect(buildAdelayMix([])).toBe("");
  });

  it("wires a single input at index 1 into amix", () => {
    expect(buildAdelayMix([2500])).toBe(
      "[1:a]adelay=2500|2500[a0];[a0]amix=inputs=1:normalize=0[aout]"
    );
  });

  it("delays each input to its offset and mixes all three", () => {
    expect(buildAdelayMix([0, 3500, 7200])).toBe(
      "[1:a]adelay=0|0[a0];" +
        "[2:a]adelay=3500|3500[a1];" +
        "[3:a]adelay=7200|7200[a2];" +
        "[a0][a1][a2]amix=inputs=3:normalize=0[aout]"
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
});

describe("parseInstalledVoiceNames", () => {
  it("extracts the leading voice name from each `say -v ?` line", () => {
    const stdout = [
      "Ava (Premium)       en_US    # Hello! My name is Ava.",
      "Samantha            en_US    # Hello! My name is Samantha.",
      "Zoe (Premium)       en_US    # Hello! My name is Zoe.",
    ].join("\n");
    const names = parseInstalledVoiceNames(stdout);
    expect(names.has("Ava")).toBe(true);
    expect(names.has("Samantha")).toBe(true);
    expect(names.has("Zoe")).toBe(true);
    // The "(Premium)" annotation is not part of the usable -v name.
    expect(names.has("(Premium)")).toBe(false);
  });

  it("ignores blank lines and returns an empty set for empty input", () => {
    expect(parseInstalledVoiceNames("").size).toBe(0);
    expect(parseInstalledVoiceNames("\n\n  \n").size).toBe(0);
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
