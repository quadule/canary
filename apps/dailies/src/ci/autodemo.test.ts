import { describe, expect, it } from "vitest";
import { parseAutodemoRequest } from "./autodemo.js";

describe("parseAutodemoRequest", () => {
  it("defaults to cinematic with a random theme and the first URL", () => {
    const r = parseAutodemoRequest(
      "Adds login. Try it at https://staging.example.com/login please."
    );
    expect(r.target).toBe("https://staging.example.com/login");
    expect(r.cinematic).toBe(true);
    expect(r.prompt).toBeNull();
  });

  it("prefers an explicit target marker over a stray URL", () => {
    const r = parseAutodemoRequest(
      "See https://github.com/x/y for context.\nautodemo-url: https://app.test/dash"
    );
    expect(r.target).toBe("https://app.test/dash");
  });

  it("reads a theme/prompt marker", () => {
    expect(
      parseAutodemoRequest(
        "Demo target: https://a.test\nautodemo-theme: 1970s heist film, as a limerick"
      ).prompt
    ).toBe("1970s heist film, as a limerick");
    expect(
      parseAutodemoRequest("Theme: noir\nDemo URL: https://a.test").prompt
    ).toBe("noir");
  });

  it("disables cinematic on a plain-demo request", () => {
    expect(
      parseAutodemoRequest("https://a.test — plain demo please").cinematic
    ).toBe(false);
    expect(parseAutodemoRequest("https://a.test\nno narration").cinematic).toBe(
      false
    );
  });

  it("accepts a local .html path target (static local demo)", () => {
    expect(parseAutodemoRequest("autodemo-url: demo/index.html").target).toBe(
      "demo/index.html"
    );
    expect(
      parseAutodemoRequest("Try fixtures/checkout.html in the repo").target
    ).toBe("fixtures/checkout.html");
  });

  it("accepts a file:// URL target", () => {
    expect(
      parseAutodemoRequest("autodemo-url: file:///tmp/demo.html").target
    ).toBe("file:///tmp/demo.html");
  });

  it("returns a null target when the body has no URL or html path", () => {
    const r = parseAutodemoRequest("Just refactors internals, no UI.");
    expect(r.target).toBeNull();
    expect(r.cinematic).toBe(true);
  });

  it("strips wrapping/trailing punctuation from a URL", () => {
    expect(parseAutodemoRequest("open (https://a.test/x).").target).toBe(
      "https://a.test/x"
    );
  });

  it("handles an empty body", () => {
    expect(parseAutodemoRequest("")).toEqual({
      target: null,
      cinematic: true,
      prompt: null,
    });
  });
});
