import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, parseProjectConfig } from "../project/config.js";
import {
  buildDecisionPrompt,
  decideDemo,
  decideDemoWithAgent,
  demoedShas,
  isAlreadyDemoed,
  parseDecision,
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

describe("buildDecisionPrompt", () => {
  const base = {
    body: "Adds a nightly backfill job.",
    changedPaths: ["app/jobs/backfill.rb"],
    hint: null,
    paths: [],
  };

  it("tells the model a non-UI change can still be demo-worthy", () => {
    const prompt = buildDecisionPrompt(base);
    // The whole reason this isn't a glob match.
    expect(prompt).toContain("no UI code at all");
    expect(prompt).toContain("background job");
  });

  it("includes the PR body and the changed files", () => {
    const prompt = buildDecisionPrompt(base);
    expect(prompt).toContain("Adds a nightly backfill job.");
    expect(prompt).toContain("app/jobs/backfill.rb");
  });

  it("passes demo.paths as a hint, explicitly not a rule", () => {
    const prompt = buildDecisionPrompt({ ...base, paths: ["app/views/**"] });
    expect(prompt).toContain("a hint, not a rule");
    expect(prompt).toContain("app/views/**");
  });

  it("includes the project hint when set, and omits the section when not", () => {
    expect(
      buildDecisionPrompt({ ...base, hint: "we care about onboarding" })
    ).toContain("we care about onboarding");
    expect(buildDecisionPrompt(base)).not.toContain(
      "What this project considers"
    );
  });

  it("caps the file list and says how many were elided", () => {
    const many = Array.from({ length: 90 }, (_, i) => `app/f${i}.rb`);
    const prompt = buildDecisionPrompt({ ...base, changedPaths: many });
    expect(prompt).toContain("Changed files (90)");
    expect(prompt).toContain("and 30 more files");
    expect(prompt).not.toContain("app/f89.rb");
  });

  it("handles an empty PR body", () => {
    expect(buildDecisionPrompt({ ...base, body: "  " })).toContain(
      "(no description)"
    );
  });
});

describe("parseDecision", () => {
  it("reads a verdict with a flow", () => {
    expect(
      parseDecision(
        '{"worth":true,"reason":"changes the payslip","flow":"Open a payslip"}'
      )
    ).toEqual({
      flow: "Open a payslip",
      reason: "changes the payslip",
      worth: true,
    });
  });

  it("tolerates a fenced or prose-wrapped reply", () => {
    expect(
      parseDecision('Sure!\n```json\n{"worth":false,"reason":"docs only"}\n```')
    ).toEqual({
      flow: null,
      reason: "docs only",
      worth: false,
    });
  });

  it("rejects a reply with no boolean verdict, so the caller can fall back", () => {
    expect(parseDecision("not json")).toBeNull();
    expect(parseDecision('{"reason":"hmm"}')).toBeNull();
    expect(parseDecision('{"worth":"yes"}')).toBeNull();
  });

  it("substitutes a placeholder rather than failing on a missing reason", () => {
    expect(parseDecision('{"worth":true}')?.reason).toBe("no reason given");
  });
});

describe("decideDemoWithAgent", () => {
  const agentConfig = parseProjectConfig({
    demo: { decide: "agent", paths: ["app/views/**"] },
    url: "http://localhost:3000",
  });
  const HEAD = "e".repeat(40);

  it("does not spend a model call on an already-demoed head", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["app/views/a.erb"],
      comments: [`<!-- dailies-demo: ${HEAD} -->`],
      config: agentConfig,
      headSha: HEAD,
    });
    expect(d.run).toBe(false);
    expect(d.decidedBy).toBe("freshness");
  });

  it("does not spend a model call when there is no target", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["app/views/a.erb"],
      config: parseProjectConfig({ demo: { decide: "agent" } }),
    });
    expect(d.decidedBy).toBe("config");
  });

  it("skips the agent entirely in paths mode", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["docs/x.md"],
      config: parseProjectConfig({
        demo: { decide: "paths", paths: ["app/**"] },
        url: "http://x",
      }),
    });
    expect(d.decidedBy).toBe("paths");
    expect(d.run).toBe(false);
  });

  it("runs on any change in always mode", async () => {
    const d = await decideDemoWithAgent({
      body: "",
      changedPaths: ["docs/x.md"],
      config: parseProjectConfig({
        demo: { decide: "always" },
        url: "http://x",
      }),
    });
    expect(d.decidedBy).toBe("always");
    expect(d.run).toBe(true);
  });

  it("falls back to path matching when no provider is available", async () => {
    // No provider pinned to a real backend: DAILIES_LLM names a nonexistent one.
    const prev = process.env.DAILIES_LLM;
    process.env.DAILIES_LLM = "nonexistent-provider";
    try {
      const d = await decideDemoWithAgent({
        body: "",
        changedPaths: ["app/views/a.erb"],
        config: agentConfig,
        headSha: "f".repeat(40),
      });
      // The path verdict survives, and the reason says the agent was unavailable.
      expect(d.run).toBe(true);
      expect(d.decidedBy).toBe("paths (agent unavailable)");
      expect(d.reason).toContain("agent decision was unavailable");
    } finally {
      if (prev === undefined) {
        process.env.DAILIES_LLM = undefined;
        Reflect.deleteProperty(process.env, "DAILIES_LLM");
      } else {
        process.env.DAILIES_LLM = prev;
      }
    }
  });
});

describe("parseDecision flow hygiene", () => {
  it("drops a flow the model volunteered on a skip", () => {
    // Observed live: the model fills `flow` in even when it says worth:false.
    const d = parseDecision(
      '{"worth":false,"reason":"specs only","flow":"Sign in and look at the screen"}'
    );
    expect(d).toEqual({ flow: null, reason: "specs only", worth: false });
  });

  it("keeps the flow when the demo will run", () => {
    expect(
      parseDecision(
        '{"worth":true,"reason":"changes net pay","flow":"Open the pay screen"}'
      )?.flow
    ).toBe("Open the pay screen");
  });
});
