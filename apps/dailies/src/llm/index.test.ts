import { createLogger } from "dailies-logger";
import { describe, expect, it } from "vitest";
import { generateJson, resolveProviders } from "./index.js";
import type { TextProvider } from "./types.js";

const log = createLogger({ level: "silent" });
const SCHEMA = { properties: { a: { type: "string" } }, type: "object" };

// A fake backend. `reply` is returned verbatim; `throws` simulates a transport
// failure (dead endpoint, missing binary, bad auth).
function fake(
  id: TextProvider["id"],
  behavior: { reply?: string; throws?: string; replies?: string[] }
): TextProvider & { calls: number } {
  const queue = [...(behavior.replies ?? [])];
  const p = {
    calls: 0,
    describe: () => `fake ${id}`,
    generateJson: () => {
      p.calls++;
      if (behavior.throws) {
        return Promise.reject(new Error(behavior.throws));
      }
      const next = queue.length > 0 ? queue.shift() : behavior.reply;
      return Promise.resolve(next ?? "");
    },
    id,
    isAvailable: () => Promise.resolve(true),
  };
  return p;
}

const parse = (raw: string): { a: string } | null => {
  try {
    const v = JSON.parse(raw) as { a?: unknown };
    return typeof v.a === "string" ? { a: v.a } : null;
  } catch {
    return null;
  }
};

function call(providers: TextProvider[]) {
  return generateJson({
    label: "narration",
    log,
    parse,
    prompt: "p",
    providers,
    schema: SCHEMA,
  });
}

describe("generateJson", () => {
  it("returns the value and names the provider that produced it", async () => {
    const result = await call([fake("claude", { reply: '{"a":"ok"}' })]);
    expect(result).toEqual({ provider: "claude", value: { a: "ok" } });
  });

  it("retries an unusable reply once within the same provider", async () => {
    const p = fake("claude", { replies: ["not json", '{"a":"ok"}'] });
    const result = await call([p]);
    expect(result).toEqual({ provider: "claude", value: { a: "ok" } });
    expect(p.calls).toBe(2);
  });

  it("gives up on a provider after two unusable replies", async () => {
    const p = fake("claude", { reply: "not json" });
    const result = await call([p]);
    expect(p.calls).toBe(2);
    expect("error" in result && result.error).toContain(
      "unusable narration JSON"
    );
  });

  it("falls through to the next provider and reports what declined", async () => {
    const dead = fake("claude", { throws: "claude: command not found" });
    const good = fake("apple", { reply: '{"a":"from apple"}' });
    const result = await call([dead, good]);
    expect(result).toEqual({ provider: "apple", value: { a: "from apple" } });
    // A transport failure must not be retried — one call, then move on.
    expect(dead.calls).toBe(1);
  });

  it("does not retry a transport failure", async () => {
    const dead = fake("openai", { throws: "HTTP 401" });
    const result = await call([dead]);
    expect(dead.calls).toBe(1);
    expect("error" in result && result.error).toContain("HTTP 401");
  });

  it("names every provider that declined, so the run notes are diagnosable", async () => {
    const result = await call([
      fake("claude", { throws: "not on PATH" }),
      fake("openai", { throws: "HTTP 500" }),
      fake("apple", { reply: "garbage" }),
    ]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("claude failed — not on PATH");
      expect(result.error).toContain("openai failed — HTTP 500");
      expect(result.error).toContain("apple replied with unusable");
    }
  });

  it("never throws, even when every provider throws", async () => {
    const result = await call([fake("claude", { throws: "boom" })]);
    expect("error" in result).toBe(true);
  });

  it("explains an empty provider list rather than failing opaquely", async () => {
    const result = await call([]);
    expect("error" in result && result.error).toContain(
      "no text provider available"
    );
  });
});

describe("resolveProviders", () => {
  it("pins exactly one provider when $DAILIES_LLM is set", async () => {
    const providers = await resolveProviders({ DAILIES_LLM: "apple" });
    expect(providers.map((p) => p.id)).toEqual(["apple"]);
  });

  it("is case- and whitespace-insensitive about the pin", async () => {
    const providers = await resolveProviders({ DAILIES_LLM: "  OpenAI " });
    expect(providers.map((p) => p.id)).toEqual(["openai"]);
  });

  it("yields nothing for an unknown pin, so the error can name it", async () => {
    expect(await resolveProviders({ DAILIES_LLM: "gpt5" })).toEqual([]);
    const result = await generateJson({
      env: { DAILIES_LLM: "gpt5" },
      label: "narration",
      log,
      parse,
      prompt: "p",
      schema: SCHEMA,
    });
    expect("error" in result && result.error).toContain(
      'no text provider named "gpt5"'
    );
  });
});
