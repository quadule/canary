import { describe, expect, it } from "vitest";
import { creditsDurationSec, parseContributors } from "./credits.js";

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
