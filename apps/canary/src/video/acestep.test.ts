import { describe, expect, it } from "vitest";
import {
  acestepBaseUrl,
  isLocalUrl,
  audioFromResponse,
  buildMusicContent,
  buildMusicPayload,
  describeMusicCurl,
  parseAudioDataUrl,
} from "./acestep.js";

describe("isLocalUrl", () => {
  it("recognizes loopback hosts and rejects remote ones", () => {
    expect(isLocalUrl("http://127.0.0.1:8001")).toBe(true);
    expect(isLocalUrl("http://localhost:8001/")).toBe(true);
    expect(isLocalUrl("http://[::1]:8001")).toBe(true);
    expect(isLocalUrl("http://192.168.1.50:8001")).toBe(false);
    expect(isLocalUrl("https://gpu-box.lan:8001")).toBe(false);
  });
});

describe("acestepBaseUrl", () => {
  it("defaults to :8001 and honors the override", () => {
    expect(acestepBaseUrl({})).toBe("http://127.0.0.1:8001");
    expect(acestepBaseUrl({ CANARY_ACESTEP_URL: "http://h:9" })).toBe(
      "http://h:9"
    );
  });
});

describe("buildMusicContent", () => {
  it("tags an instrumental bed and passes a song through as natural language", () => {
    expect(buildMusicContent("noir jazz", true)).toBe(
      "<prompt>noir jazz</prompt><lyrics>[instrumental]</lyrics>"
    );
    expect(buildMusicContent("upbeat pop", false)).toBe("upbeat pop");
  });

  it("tags supplied lyrics into a song (song mode), trimming them", () => {
    expect(
      buildMusicContent("upbeat pop", false, "  [verse]\nla la la  ")
    ).toBe("<prompt>upbeat pop</prompt><lyrics>[verse]\nla la la</lyrics>");
  });

  it("ignores blank lyrics and falls back to sample-mode content", () => {
    expect(buildMusicContent("upbeat pop", false, "   ")).toBe("upbeat pop");
  });

  it("ignores lyrics for an instrumental bed", () => {
    expect(buildMusicContent("noir jazz", true, "[verse]\nwords")).toBe(
      "<prompt>noir jazz</prompt><lyrics>[instrumental]</lyrics>"
    );
  });
});

describe("buildMusicPayload", () => {
  it("nests duration under audio_config for an instrumental bed", () => {
    expect(
      buildMusicPayload({ directionText: "noir", seconds: 12.4, instrumental: true })
    ).toEqual({
      messages: [
        {
          role: "user",
          content: "<prompt>noir</prompt><lyrics>[instrumental]</lyrics>",
        },
      ],
      audio_config: { duration: 12 },
    });
  });

  it("uses sample_mode + vocal_language for a song without lyrics", () => {
    const p = buildMusicPayload({
      directionText: "upbeat pop",
      seconds: 30,
      instrumental: false,
    });
    expect(p.sample_mode).toBe(true);
    expect(p.messages).toEqual([{ role: "user", content: "upbeat pop" }]);
    expect(p.audio_config).toEqual({ duration: 30, vocal_language: "en" });
  });

  it("sings supplied lyrics in tagged mode, OMITTING duration so it isn't instrumental", () => {
    const p = buildMusicPayload({
      directionText: "upbeat pop",
      seconds: 25,
      instrumental: false,
      lyrics: "[chorus]\nCanary sings",
    });
    // Tagged mode → the LM must NOT invent its own lyrics.
    expect(p.sample_mode).toBeUndefined();
    expect(p.messages).toEqual([
      {
        role: "user",
        content:
          "<prompt>upbeat pop</prompt><lyrics>[chorus]\nCanary sings</lyrics>",
      },
    ]);
    // CRITICAL: no duration — pinning it makes a lyric song come out instrumental.
    expect(p.audio_config).toEqual({ vocal_language: "en" });
  });

  it("rounds duration up to >=1 and includes model only when set", () => {
    expect(
      (buildMusicPayload({ directionText: "x", seconds: 0, instrumental: true })
        .audio_config as { duration: number }).duration
    ).toBe(1);
    expect(
      buildMusicPayload({
        directionText: "x",
        seconds: 5,
        instrumental: true,
        model: "acestep/x",
      }).model
    ).toBe("acestep/x");
  });
});

describe("parseAudioDataUrl", () => {
  it("decodes a base64 audio data URL", () => {
    const url = `data:audio/mpeg;base64,${Buffer.from("hi").toString("base64")}`;
    expect(parseAudioDataUrl(url)?.toString()).toBe("hi");
  });
  it("rejects non-data / non-base64 / empty values", () => {
    expect(parseAudioDataUrl("https://x/y.mp3")).toBeNull();
    expect(parseAudioDataUrl("data:audio/mpeg,raw")).toBeNull();
    expect(parseAudioDataUrl(undefined)).toBeNull();
    expect(parseAudioDataUrl("data:audio/mpeg;base64,")).toBeNull();
  });
});

describe("audioFromResponse", () => {
  it("pulls audio bytes from the chat-completions shape", () => {
    const body = {
      choices: [
        {
          message: {
            audio: [
              {
                audio_url: {
                  url: `data:audio/mpeg;base64,${Buffer.from("song").toString("base64")}`,
                },
              },
            ],
          },
        },
      ],
    };
    expect(audioFromResponse(body)?.toString()).toBe("song");
  });
  it("returns null when there's no audio", () => {
    expect(audioFromResponse({ choices: [{ message: { content: "hi" } }] })).toBeNull();
    expect(audioFromResponse({})).toBeNull();
  });
});

// Live integration: exercise the real provider against a running ACE-Step server
// (heavy + slow), gated behind CANARY_TEST_ACESTEP=1 so it never runs in CI.
describe.skipIf(process.env.CANARY_TEST_ACESTEP !== "1")("ACE-Step live", () => {
  it("generates an instrumental bed via the provider", async () => {
    const { resolveAceStepMusic } = await import("./acestep.js");
    const { music } = await resolveAceStepMusic({
      env: process.env,
      // biome-ignore lint/suspicious/noExplicitAny: tiny test logger stub
      log: { debug() {}, info() {}, warn() {}, error() {} } as any,
    });
    expect(music, "ACE-Step server should be reachable").toBeDefined();
    const { readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const out = path.join(os.tmpdir(), `canary-acestep-${process.pid}.wav`);
    try {
      await music?.bed("calm ambient piano, gentle and cinematic", 8, out);
      const bytes = await readFile(out);
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await rm(out, { force: true });
    }
  }, 300_000);
});

describe("describeMusicCurl", () => {
  it("redacts the key and includes auth only when present", () => {
    const payload = buildMusicPayload({
      directionText: "c",
      seconds: 10,
      instrumental: true,
    });
    const withKey = describeMusicCurl({
      baseUrl: "http://127.0.0.1:8001",
      payload,
      hasKey: true,
    });
    expect(withKey).toContain("$CANARY_ACESTEP_API_KEY");
    expect(withKey).not.toMatch(/Bearer (?!\$)/);
    const noKey = describeMusicCurl({
      baseUrl: "http://127.0.0.1:8001",
      payload,
      hasKey: false,
    });
    expect(noKey).not.toContain("Authorization");
  });
});
