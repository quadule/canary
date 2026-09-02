import { describe, expect, it } from "vitest";
import {
  deserializeMetrics,
  formatMetric,
  formatMetricLines,
  formatValue,
  parseMetric,
  parseMetrics,
  serializeMetrics,
} from "./metrics.js";

describe("parseMetric", () => {
  it("reads name=value", () => {
    expect(parseMetric("coverage=42.5")).toEqual({
      name: "coverage",
      value: 42.5,
    });
    expect(parseMetric("steps=17")).toEqual({ name: "steps", value: 17 });
  });

  it("tolerates a trailing percent sign and surrounding space", () => {
    // `coverage=42.5%` is the obvious thing to type.
    expect(parseMetric(" coverage = 42.5% ")).toEqual({
      name: "coverage",
      value: 42.5,
    });
  });

  it("accepts zero and negative values", () => {
    expect(parseMetric("coverage=0")).toEqual({ name: "coverage", value: 0 });
    expect(parseMetric("delta=-3.5")).toEqual({ name: "delta", value: -3.5 });
  });

  it("rejects anything that isn't a finite number, rather than recording NaN", () => {
    for (const bad of [
      "coverage",
      "coverage=",
      "=42",
      "coverage=high",
      "coverage=NaN",
      "coverage=Infinity",
      "",
    ]) {
      expect(parseMetric(bad)).toBeNull();
    }
  });
});

describe("parseMetrics", () => {
  it("collects the good and reports the bad", () => {
    const { invalid, metrics } = parseMetrics([
      "coverage=42",
      "junk",
      "steps=3",
    ]);
    expect(metrics).toEqual([
      { name: "coverage", value: 42 },
      { name: "steps", value: 3 },
    ]);
    expect(invalid).toEqual(["junk"]);
  });

  it("treats a repeated name as an override, not a duplicate", () => {
    const { metrics } = parseMetrics(["coverage=10", "coverage=20"]);
    expect(metrics).toEqual([{ name: "coverage", value: 20 }]);
  });
});

describe("formatValue", () => {
  it("keeps integers bare and rounds the rest to one decimal", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(42.567)).toBe("42.6");
    expect(formatValue(42.51)).toBe("42.5");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-3.25)).toBe("-3.3");
  });

  it("does not promise a rounding direction at an exact .x5 boundary", () => {
    // toFixed rounds the DOUBLE, and 42.55 is stored slightly below 42.55, so
    // it yields "42.5". Asserting "42.6" here would be asserting a falsehood
    // about floats. A display helper doesn't need to resolve that.
    expect(["42.5", "42.6"]).toContain(formatValue(42.55));
  });
});

describe("formatMetric", () => {
  it("says so on a first run, with nothing to compare to", () => {
    expect(formatMetric({ name: "coverage", value: 42.5 })).toBe(
      "coverage 42.5 (first run)"
    );
  });

  it("shows a rise and a fall with the previous value", () => {
    expect(
      formatMetric(
        { name: "coverage", value: 42.5 },
        { name: "coverage", value: 39.3 }
      )
    ).toBe("coverage 42.5 (+3.2 since 39.3)");
    expect(
      formatMetric(
        { name: "coverage", value: 30 },
        { name: "coverage", value: 61 }
      )
    ).toBe("coverage 30 (−31 since 61)");
  });

  it("calls a negligible move unchanged rather than showing +0.0", () => {
    expect(
      formatMetric(
        { name: "coverage", value: 42.5 },
        { name: "coverage", value: 42.52 }
      )
    ).toBe("coverage 42.5 (unchanged)");
  });
});

describe("marker round-trip", () => {
  it("serializes sorted, so the marker is stable regardless of flag order", () => {
    const a = serializeMetrics([
      { name: "steps", value: 3 },
      { name: "coverage", value: 42.5 },
    ]);
    const b = serializeMetrics([
      { name: "coverage", value: 42.5 },
      { name: "steps", value: 3 },
    ]);
    expect(a).toBe("coverage=42.5 steps=3");
    expect(a).toBe(b);
  });

  it("round-trips through the marker text", () => {
    const metrics = [
      { name: "coverage", value: 42.5 },
      { name: "steps", value: 3 },
    ];
    expect(deserializeMetrics(serializeMetrics(metrics))).toEqual([
      { name: "coverage", value: 42.5 },
      { name: "steps", value: 3 },
    ]);
  });

  it("reads an older marker with no metrics as none", () => {
    expect(deserializeMetrics("")).toEqual([]);
    expect(deserializeMetrics("   ")).toEqual([]);
  });

  it("ignores tokens it doesn't understand, so a newer marker still parses", () => {
    expect(
      deserializeMetrics("coverage=42.5 somethingelse coverage2=1")
    ).toEqual([
      { name: "coverage", value: 42.5 },
      { name: "coverage2", value: 1 },
    ]);
  });
});

describe("formatMetricLines", () => {
  it("pairs each current metric with its previous value", () => {
    expect(
      formatMetricLines(
        [
          { name: "coverage", value: 42.5 },
          { name: "steps", value: 4 },
        ],
        [{ name: "coverage", value: 39.3 }]
      )
    ).toEqual(["coverage 42.5 (+3.2 since 39.3)", "steps 4 (first run)"]);
  });

  it("drops a metric that stopped being taken — not a regression to report", () => {
    expect(
      formatMetricLines(
        [{ name: "coverage", value: 42 }],
        [{ name: "gone", value: 9 }]
      )
    ).toEqual(["coverage 42 (first run)"]);
  });

  it("is empty when nothing was measured", () => {
    expect(formatMetricLines([], [{ name: "coverage", value: 1 }])).toEqual([]);
  });
});
