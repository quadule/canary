import { describe, expect, it } from "vitest";
import {
  attributionFor,
  buildSearchUrl,
  loudestIndex,
  parseSearchDocs,
  pickAudioFile,
  sanitizeQuery,
  windowStarts,
} from "./archive.js";

describe("loudestIndex", () => {
  it("returns the index of the max level (first wins on ties)", () => {
    expect(loudestIndex([-30, -12, -18, -12])).toBe(1);
    expect(loudestIndex([-40])).toBe(0);
  });
  it("returns -1 for an empty array", () => {
    expect(loudestIndex([])).toBe(-1);
  });
});

describe("windowStarts", () => {
  it("spaces `count` starts across [0, maxStart] inclusive", () => {
    expect(windowStarts(40, 5)).toEqual([0, 10, 20, 30, 40]);
  });
  it("returns [0] when there's no room to move or only one probe", () => {
    expect(windowStarts(0, 8)).toEqual([0]);
    expect(windowStarts(-5, 8)).toEqual([0]);
    expect(windowStarts(40, 1)).toEqual([0]);
  });
});

describe("sanitizeQuery", () => {
  it("strips Lucene-significant chars and collapses whitespace", () => {
    expect(sanitizeQuery('noir: "detective" (1970s)/heist')).toBe(
      "noir detective 1970s heist"
    );
  });
  it("caps length", () => {
    expect(sanitizeQuery("a".repeat(200)).length).toBe(120);
  });
});

describe("buildSearchUrl", () => {
  it("constrains to CC netlabel audio with a license and biases beds", () => {
    const url = buildSearchUrl("noir jazz", true);
    // URLSearchParams encodes spaces as '+'; undo both layers to read the query.
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(url).toContain("advancedsearch.php");
    expect(decoded).toContain("collection:netlabels");
    expect(decoded).toContain("licenseurl:[* TO *]");
    expect(decoded).toContain("instrumental");
    expect(decoded).toContain("mediatype:audio");
  });
  it("omits the instrumental bias for songs", () => {
    const decoded = decodeURIComponent(buildSearchUrl("upbeat pop", false)).replace(
      /\+/g,
      " "
    );
    expect(decoded).not.toContain("instrumental");
  });
});

describe("parseSearchDocs", () => {
  it("normalizes docs incl. array-valued creator/license", () => {
    const tracks = parseSearchDocs({
      response: {
        docs: [
          {
            identifier: "a1",
            title: "Track One",
            creator: ["Artist X"],
            licenseurl: ["https://creativecommons.org/licenses/by/4.0/"],
          },
          { identifier: "a2" },
          { title: "no id — dropped" },
        ],
      },
    });
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toEqual({
      identifier: "a1",
      title: "Track One",
      creator: "Artist X",
      licenseurl: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(tracks[1]).toMatchObject({ identifier: "a2", title: "a2" });
  });
  it("returns [] for a malformed body", () => {
    expect(parseSearchDocs({})).toEqual([]);
    expect(parseSearchDocs(null)).toEqual([]);
  });
});

describe("pickAudioFile", () => {
  it("prefers an mp3, then other audio formats", () => {
    expect(
      pickAudioFile({ files: [{ name: "cover.jpg" }, { name: "song.mp3" }] })
    ).toBe("song.mp3");
    expect(pickAudioFile({ files: [{ name: "a.flac" }] })).toBe("a.flac");
    expect(pickAudioFile({ files: [{ name: "notes.txt" }] })).toBeNull();
    expect(pickAudioFile({})).toBeNull();
  });
});

describe("attributionFor", () => {
  it("builds a creditable line with creator + license + details URL", () => {
    expect(
      attributionFor({
        identifier: "x",
        title: "Song",
        creator: "Y",
        licenseurl: "https://cc/by",
      })
    ).toBe('music: "Song" by Y (https://cc/by) — https://archive.org/details/x');
  });
});

// Live smoke test: hit the real advancedsearch and confirm it returns tracks.
// Opt-in (CANARY_TEST_ARCHIVE=1) so it never flakes CI on network.
describe.skipIf(process.env.CANARY_TEST_ARCHIVE !== "1")("archive.org live", () => {
  it("search returns CC netlabel tracks", async () => {
    const url = buildSearchUrl("ambient piano", true);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    expect(res.ok).toBe(true);
    const tracks = parseSearchDocs(await res.json());
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks[0]?.identifier).toBeTruthy();
  }, 30_000);

  it("provider fetches, trims, and writes a bed (needs ffmpeg)", async () => {
    const { findFfmpeg } = await import("./condense.js");
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) {
      return; // no ffmpeg here — search test already covered the API
    }
    const notes: string[] = [];
    const { resolveArchiveMusic } = await import("./archive.js");
    const { music } = resolveArchiveMusic({
      env: { CANARY_ARCHIVE_MUSIC: "1" },
      ffmpeg,
      // biome-ignore lint/suspicious/noExplicitAny: tiny test logger stub
      log: { debug() {}, info() {}, warn() {}, error() {} } as any,
      notes,
    });
    const { readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const out = path.join(os.tmpdir(), `canary-archive-${process.pid}.wav`);
    try {
      await music?.bed("calm ambient piano", 6, out);
      const bytes = await readFile(out);
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.length).toBeGreaterThan(1000);
      expect(notes.some((n) => n.startsWith("music:"))).toBe(true);
    } finally {
      await rm(out, { force: true });
    }
  }, 120_000);
});
