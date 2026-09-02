import { describe, expect, it } from "vitest";
import {
  STYLES,
  selectStyle,
  selectThemes,
  THEMES,
  type ThemeCategory,
  weightedIndex,
} from "./themes.js";

const ALLOWED_CATEGORIES: ThemeCategory[] = [
  "movie",
  "tv",
  "documentary",
  "commercial",
  "training",
  "radio",
  "sports",
  "game_show",
  "soap",
  "news",
  "kids",
];

describe("THEMES", () => {
  it("contains at least 300 entries", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(300);
  });

  it("has no duplicate labels", () => {
    const labels = THEMES.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("only uses allowed categories", () => {
    const allowed = new Set<ThemeCategory>(ALLOWED_CATEGORIES);
    for (const theme of THEMES) {
      expect(allowed.has(theme.category)).toBe(true);
    }
  });
});

describe("weightedIndex", () => {
  // STYLES cumulative weights, the real-world input.
  const cumulative = [88, 93, 96, 98, 100];

  it("returns the first positive-weight index at r=0", () => {
    expect(weightedIndex(cumulative, 0)).toBe(0);
  });

  it("returns the last index as r approaches 1", () => {
    expect(weightedIndex(cumulative, 0.999)).toBe(4);
  });

  it("skips a leading zero weight at r=0", () => {
    // cumulative [0, 5, 10] → r=0 must land on bucket 1, not 0.
    expect(weightedIndex([0, 5, 10], 0)).toBe(1);
  });

  it("returns 0 for an all-zero weights array (no throw)", () => {
    expect(weightedIndex([0, 0, 0], 0)).toBe(0);
    expect(weightedIndex([0, 0, 0], 0.5)).toBe(0);
    expect(weightedIndex([0, 0, 0], 0.999)).toBe(0);
  });

  it("always returns 0 for a single-item list", () => {
    expect(weightedIndex([5], 0)).toBe(0);
    expect(weightedIndex([5], 0.999)).toBe(0);
  });

  it("does not throw or escape the array at the boundaries", () => {
    expect(weightedIndex(cumulative, 1)).toBeLessThan(cumulative.length);
    expect(weightedIndex(cumulative, -1)).toBe(0);
    expect(weightedIndex([], 0.5)).toBe(0);
  });
});

describe("selectThemes", () => {
  it("returns 3 distinct themes by default", () => {
    const picked = selectThemes(3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((t) => t.label)).size).toBe(3);
  });

  it("returns every theme distinctly when count exceeds the catalog", () => {
    const picked = selectThemes(99_999);
    expect(picked).toHaveLength(THEMES.length);
    expect(new Set(picked.map((t) => t.label)).size).toBe(THEMES.length);
  });

  it("does not mutate THEMES", () => {
    const before = THEMES.map((t) => t.label);
    selectThemes(5);
    expect(THEMES.map((t) => t.label)).toEqual(before);
  });
});

describe("STYLES", () => {
  it("weights sum to 100", () => {
    const sum = STYLES.reduce((total, style) => total + style.weight, 0);
    expect(sum).toBe(100);
  });

  it("includes exactly the five expected ids", () => {
    const ids = STYLES.map((style) => style.id).sort();
    expect(ids).toEqual(["haiku", "limerick", "poem", "prose", "song_verse"]);
  });
});

describe("selectStyle", () => {
  it("always returns one of the known style ids", () => {
    const known = new Set(STYLES.map((style) => style.id));
    for (let i = 0; i < 200; i++) {
      expect(known.has(selectStyle())).toBe(true);
    }
  });
});
