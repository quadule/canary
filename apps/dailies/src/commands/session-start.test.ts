import { describe, expect, it } from "vitest";
import { parseViewport } from "./session-start.js";

describe("parseViewport", () => {
  it("parses WIDTHxHEIGHT", () => {
    expect(parseViewport("1920x1200")).toEqual({ width: 1920, height: 1200 });
    expect(parseViewport("1280X720")).toEqual({ width: 1280, height: 720 });
    expect(parseViewport(" 800x600 ")).toEqual({ width: 800, height: 600 });
  });

  it("rejects malformed specs", () => {
    for (const bad of ["1920", "x1200", "1920x", "axb", "1920 1200", "0x600"]) {
      expect(() => parseViewport(bad)).toThrow(/Invalid --viewport/);
    }
  });
});
