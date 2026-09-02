import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, parseProjectConfig } from "../project/config.js";
import {
  decideDemo,
  demoedShas,
  isAlreadyDemoed,
  parseDemoRequest,
} from "./demo-request.js";

describe("parseDemoRequest", () => {
  it("defaults to cinematic with a random theme and the first URL", () => {
    const r = parseDemoRequest(
      "Adds login. Try it at https://staging.example.com/login please."
    );
    expect(r.target).toBe("https://staging.example.com/login");
    expect(r.cinematic).toBe(true);
    expect(r.prompt).toBeNull();
  });

  it("prefers an explicit target marker over a stray URL", () => {
    const r = parseDemoRequest(
      "See https://github.com/x/y for context.\ndailies-url: https://app.test/dash"
    );
    expect(r.target).toBe("https://app.test/dash");
  });

  it("reads a theme/prompt marker", () => {
    expect(
      parseDemoRequest(
        "Demo target: https://a.test\ndailies-theme: 1970s heist film, as a limerick"
      ).prompt
    ).toBe("1970s heist film, as a limerick");
    expect(
      parseDemoRequest("Theme: noir\nDemo URL: https://a.test").prompt
    ).toBe("noir");
  });

  it("disables cinematic on a plain-demo request", () => {
    expect(
      parseDemoRequest("https://a.test — plain demo please").cinematic
    ).toBe(false);
    expect(parseDemoRequest("https://a.test\nno narration").cinematic).toBe(
      false
    );
  });

  it("accepts a local .html path target (static local demo)", () => {
    expect(parseDemoRequest("dailies-url: demo/index.html").target).toBe(
      "demo/index.html"
    );
    expect(
      parseDemoRequest("Try fixtures/checkout.html in the repo").target
    ).toBe("fixtures/checkout.html");
  });

  it("accepts a file:// URL target", () => {
    expect(parseDemoRequest("dailies-url: file:///tmp/demo.html").target).toBe(
      "file:///tmp/demo.html"
    );
  });

  it("returns a null target when the body has no URL or html path", () => {
    const r = parseDemoRequest("Just refactors internals, no UI.");
    expect(r.target).toBeNull();
    expect(r.cinematic).toBe(true);
  });

  it("strips wrapping/trailing punctuation from a URL", () => {
    expect(parseDemoRequest("open (https://a.test/x).").target).toBe(
      "https://a.test/x"
    );
  });

  it("handles an empty body", () => {
    expect(parseDemoRequest("")).toEqual({
      target: null,
      cinematic: true,
      prompt: null,
    });
  });
});

describe("decideDemo", () => {
  const config = parseProjectConfig({
    demo: { paths: ["app/views/**"], prompt: "repo default theme" },
    url: "http://localhost:3000",
  });

  it("falls back to the repo default target and theme", () => {
    const d = decideDemo({
      body: "Adds a field.",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.run).toBe(true);
    expect(d.target).toBe("http://localhost:3000");
    expect(d.prompt).toBe("repo default theme");
    expect(d.cinematic).toBe(true);
  });

  it("lets the PR body override the target and theme", () => {
    const d = decideDemo({
      body: "dailies-url: https://pr-1.review.app\ndailies-theme: noir",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.target).toBe("https://pr-1.review.app");
    expect(d.prompt).toBe("noir");
  });

  it("lets the PR body opt out of the cinematic cut", () => {
    const d = decideDemo({
      body: "plain demo please",
      changedPaths: ["app/views/a.erb"],
      config,
    });
    expect(d.cinematic).toBe(false);
  });

  it("honors a repo default of cinematic:false, with no body opinion", () => {
    const plain = parseProjectConfig({
      demo: { cinematic: false },
      url: "http://x",
    });
    expect(
      decideDemo({ body: "", changedPaths: ["a"], config: plain }).cinematic
    ).toBe(false);
  });

  it("skips when no changed file is user-facing", () => {
    const d = decideDemo({ body: "", changedPaths: ["README.md"], config });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("match demo.paths");
    // Still reports the target it WOULD have used — useful in the log.
    expect(d.target).toBe("http://localhost:3000");
  });

  it("skips with actionable advice when there is no target anywhere", () => {
    const d = decideDemo({
      body: "",
      changedPaths: ["app/views/a.erb"],
      config: EMPTY_CONFIG,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain(".dailies/config.json");
    expect(d.reason).toContain("dailies-url:");
  });

  it("runs on any change when the repo configures no paths", () => {
    const anyChange = parseProjectConfig({ url: "http://x" });
    expect(
      decideDemo({ body: "", changedPaths: ["docs/x.md"], config: anyChange })
        .run
    ).toBe(true);
  });
});

describe("isAlreadyDemoed", () => {
  const marker = (sha: string) =>
    `🎬 demo ready\n<!-- dailies-demo: ${sha} -->`;
  const HEAD = "a".repeat(40);

  it("matches a full sha recorded in a previous comment", () => {
    expect(isAlreadyDemoed(HEAD, [marker(HEAD)])).toBe(true);
  });

  it("matches a short sha against the full head", () => {
    expect(isAlreadyDemoed(HEAD, [marker("aaaaaaa")])).toBe(true);
  });

  it("is false when the PR has moved on", () => {
    expect(isAlreadyDemoed("b".repeat(40), [marker(HEAD)])).toBe(false);
  });

  it("ignores unrelated comments and prose mentioning the sha", () => {
    expect(isAlreadyDemoed(HEAD, ["looks good to me", "please rebase"])).toBe(
      false
    );
    // Only the marker counts — a sha quoted in prose must not suppress a demo.
    expect(isAlreadyDemoed(HEAD, [`built from ${HEAD}`])).toBe(false);
  });

  it("is false with no head sha, so a broken lookup demos rather than skips", () => {
    expect(isAlreadyDemoed("", [marker(HEAD)])).toBe(false);
  });

  it("finds the marker among several comments, case-insensitively", () => {
    const comments = [
      "nope",
      marker("BBBBBBB"),
      "also nope",
      marker(HEAD.slice(0, 12)),
    ];
    expect(isAlreadyDemoed(HEAD, comments)).toBe(true);
    expect(demoedShas(comments)).toHaveLength(2);
  });
});

describe("decideDemo freshness", () => {
  const config = parseProjectConfig({ url: "http://localhost:3000" });
  const HEAD = "c".repeat(40);
  const marker = (sha: string) => `🎬 demo\n<!-- dailies-demo: ${sha} -->`;

  it("skips a head that already has a demo", () => {
    const d = decideDemo({
      body: "",
      changedPaths: ["app/a.rb"],
      comments: [marker(HEAD)],
      config,
      headSha: HEAD,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe(`already demoed at ${HEAD.slice(0, 7)}`);
  });

  it("runs once the PR moves to a new head", () => {
    const d = decideDemo({
      body: "",
      changedPaths: ["app/a.rb"],
      comments: [marker(HEAD)],
      config,
      headSha: "d".repeat(40),
    });
    expect(d.run).toBe(true);
  });

  it("runs when there are no comments at all", () => {
    expect(
      decideDemo({
        body: "",
        changedPaths: ["app/a.rb"],
        config,
        headSha: HEAD,
      }).run
    ).toBe(true);
  });

  it("reports the stale demo before complaining about a missing target", () => {
    // An already-demoed PR should be quiet, not nag about configuration.
    const d = decideDemo({
      body: "",
      changedPaths: ["app/a.rb"],
      comments: [marker(HEAD)],
      config: EMPTY_CONFIG,
      headSha: HEAD,
    });
    expect(d.reason).toContain("already demoed");
  });
});
