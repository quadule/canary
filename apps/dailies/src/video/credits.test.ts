import { describe, expect, it } from "vitest";
import {
  buildCreditSections,
  creditsDurationSec,
  creditsLines,
  parseContributors,
} from "./credits.js";

describe("parseContributors", () => {
  it("returns [] for empty input", () => {
    expect(parseContributors("")).toEqual([]);
    expect(parseContributors("   \n\n  \n")).toEqual([]);
  });

  it("counts commits per author and sorts by count desc", () => {
    const out = parseContributors("Alice\nBob\nAlice\nAlice\nBob\n");
    expect(out).toEqual([
      { name: "Alice", commits: 3 },
      { name: "Bob", commits: 2 },
    ]);
  });

  it("breaks ties by name ascending", () => {
    const out = parseContributors("Charlie\nAlice\nBob\n");
    expect(out).toEqual([
      { name: "Alice", commits: 1 },
      { name: "Bob", commits: 1 },
      { name: "Charlie", commits: 1 },
    ]);
  });

  it("dedupes by name and trims whitespace", () => {
    const out = parseContributors("  Alice  \nAlice\n\tAlice\t\n");
    expect(out).toEqual([{ name: "Alice", commits: 3 }]);
  });

  it("ignores blank and whitespace-only lines", () => {
    const out = parseContributors("Alice\n\n   \nBob\n\t\n");
    expect(out).toEqual([
      { name: "Alice", commits: 1 },
      { name: "Bob", commits: 1 },
    ]);
  });
});

describe("buildCreditSections", () => {
  it("caps named contributors and collapses the rest into 'and N more'", () => {
    const contributors = Array.from({ length: 23 }, (_, i) => ({
      name: `Dev ${i}`,
      commits: 1,
    }));
    const [featuring] = buildCreditSections({
      contributors,
      models: [],
    });
    expect(featuring?.title).toBe("Featuring");
    expect(featuring?.entries).toHaveLength(21); // 20 named + "and N more"
    expect(featuring?.entries.at(-1)).toBe("and 3 more");
  });

  it("includes music and tools, and drops empty sections", () => {
    const sections = buildCreditSections({
      contributors: [],
      music: 'music: "X" by Y (cc) — url',
      models: ["Narration — Claude (Anthropic)"],
    });
    expect(sections.map((s) => s.title)).toEqual(["Music", "Made with"]);
    expect(sections[0]?.entries).toEqual(['music: "X" by Y (cc) — url']);
  });

  it("returns [] when there's nothing to credit", () => {
    expect(buildCreditSections({ contributors: [], models: [] })).toEqual([]);
  });
});

describe("creditsLines", () => {
  it("renders heading, then each section with a blank separator and its title", () => {
    const lines = creditsLines(
      [
        { title: "Featuring", entries: ["Alice", "Bob"] },
        { title: "Music", entries: ["a song"] },
      ],
      "THE FILM"
    );
    expect(lines).toEqual([
      "THE FILM",
      "",
      "Featuring",
      "Alice",
      "Bob",
      "",
      "Music",
      "a song",
    ]);
  });

  it("skips empty sections and works with no heading", () => {
    expect(
      creditsLines([{ title: "Made with", entries: ["Claude"] }], undefined)
    ).toEqual(["Made with", "Claude"]);
  });
});

describe("creditsDurationSec", () => {
  const HEIGHT = 720;

  it("clamps a tiny roll up to the minimum", () => {
    // One line at ~0.7s/line is well under MIN_SEC.
    expect(creditsDurationSec(1, HEIGHT)).toBe(4);
  });

  it("clamps a huge roll down to the maximum", () => {
    expect(creditsDurationSec(1000, HEIGHT)).toBe(20);
  });

  it("scales between the bounds with line count", () => {
    const few = creditsDurationSec(8, HEIGHT);
    const more = creditsDurationSec(15, HEIGHT);
    expect(few).toBeGreaterThan(4);
    expect(few).toBeLessThan(20);
    expect(more).toBeGreaterThan(4);
    expect(more).toBeLessThan(20);
    expect(more).toBeGreaterThan(few);
  });

  it("never exceeds the max regardless of geometry height", () => {
    expect(creditsDurationSec(50, 100)).toBeLessThanOrEqual(20);
    expect(creditsDurationSec(50, 4000)).toBeLessThanOrEqual(20);
  });
});
