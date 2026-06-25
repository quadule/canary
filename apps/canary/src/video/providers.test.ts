import { describe, expect, it } from "vitest";
import {
  aspectRatioFor,
  buildImagePrompt,
  buildMusicPrompt,
  buildTtsPrompt,
  extractInlineData,
  pcmToWav,
  pickTtsVoice,
  readApiKey,
  resolveMediaProviders,
} from "./providers.js";

// A no-op logger satisfying the bits resolveMediaProviders touches.
const noopLog = {
  debug() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
  error() {
    // no-op
  },
} as unknown as Parameters<typeof resolveMediaProviders>[0]["log"];

describe("pcmToWav", () => {
  it("prepends a 44-byte canonical WAV header", () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = pcmToWav(pcm, 24_000, 1);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    // The PCM payload is appended verbatim after the header.
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("writes correct sizes, format, and rate fields", () => {
    const pcm = Buffer.alloc(100);
    const sampleRate = 24_000;
    const channels = 1;
    const wav = pcmToWav(pcm, sampleRate, channels);

    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF size
    expect(wav.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(channels);
    expect(wav.readUInt32LE(24)).toBe(sampleRate);
    const blockAlign = (channels * 16) / 8;
    expect(wav.readUInt32LE(28)).toBe(sampleRate * blockAlign); // byteRate
    expect(wav.readUInt16LE(32)).toBe(blockAlign);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data size
  });

  it("computes block align and byte rate for stereo", () => {
    const wav = pcmToWav(Buffer.alloc(8), 44_100, 2);
    expect(wav.readUInt16LE(32)).toBe(4); // 2ch * 16bit / 8
    expect(wav.readUInt32LE(28)).toBe(44_100 * 4);
  });
});

describe("extractInlineData", () => {
  it("decodes the first inlineData base64 part to a Buffer", () => {
    const payload = Buffer.from("hello media");
    const body = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/L16;rate=24000",
                  data: payload.toString("base64"),
                },
              },
            ],
          },
        },
      ],
    };
    const found = extractInlineData(body);
    expect(found).not.toBeNull();
    expect(found?.bytes.equals(payload)).toBe(true);
    expect(found?.mimeType).toBe("audio/L16;rate=24000");
  });

  it("skips text parts and finds inlineData later in the list", () => {
    const payload = Buffer.from("img");
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { text: "here is your image" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: payload.toString("base64"),
                },
              },
            ],
          },
        },
      ],
    };
    expect(extractInlineData(body)?.bytes.equals(payload)).toBe(true);
  });

  it("returns null on a missing / malformed shape", () => {
    expect(extractInlineData(null)).toBeNull();
    expect(extractInlineData({})).toBeNull();
    expect(extractInlineData({ candidates: [] })).toBeNull();
    expect(
      extractInlineData({
        candidates: [{ content: { parts: [{ text: "x" }] } }],
      })
    ).toBeNull();
    expect(
      extractInlineData({
        candidates: [{ content: { parts: [{ inlineData: { data: "" } }] } }],
      })
    ).toBeNull();
  });
});

describe("buildTtsPrompt", () => {
  it("includes the verbatim narration and an expressive directive", () => {
    const prompt = buildTtsPrompt("The vault clicked open.");
    expect(prompt).toContain("The vault clicked open.");
    expect(prompt.toLowerCase()).toContain("expressive");
    expect(prompt.toLowerCase()).toContain("voiceover");
  });
});

describe("pickTtsVoice", () => {
  it("honors an explicit CANARY_TTS_VOICE override (trimmed)", () => {
    expect(pickTtsVoice({ CANARY_TTS_VOICE: "  Kore  " })).toBe("Kore");
  });

  it("picks from the supported voices via the random fn", () => {
    // random()=0 → first voice; deterministic so a session is reproducible.
    expect(pickTtsVoice({}, () => 0)).toBe("Zephyr");
    // A near-1 value still lands in-range (no off-by-one).
    const voice = pickTtsVoice({}, () => 0.999);
    expect(typeof voice).toBe("string");
    expect(voice.length).toBeGreaterThan(0);
  });
});

describe("buildImagePrompt", () => {
  it("embeds the direction and demands no text + negative space", () => {
    const prompt = buildImagePrompt("noir radio drama");
    expect(prompt).toContain("noir radio drama");
    expect(prompt.toLowerCase()).toContain("background");
    expect(prompt.toLowerCase()).toContain("negative space");
    expect(prompt.toLowerCase()).toContain("lower third");
    // Must explicitly forbid lettering (text is overlaid later).
    expect(prompt.toLowerCase()).toContain("no text");
  });
});

describe("buildMusicPrompt", () => {
  it("requests an instrumental bed with no vocals", () => {
    const prompt = buildMusicPrompt("1970s heist thriller", 30, false);
    expect(prompt).toContain("1970s heist thriller");
    expect(prompt.toLowerCase()).toContain("instrumental");
    expect(prompt.toLowerCase()).toContain("no vocals");
    expect(prompt).toContain("30");
  });

  it("requests a full song with vocals", () => {
    const prompt = buildMusicPrompt("upbeat pop montage", 45, true);
    expect(prompt.toLowerCase()).toContain("song");
    expect(prompt.toLowerCase()).toContain("vocals");
    expect(prompt).toContain("45");
  });
});

describe("aspectRatioFor", () => {
  it("maps common geometries to the nearest aspect ratio", () => {
    expect(aspectRatioFor(1920, 1080)).toBe("16:9");
    expect(aspectRatioFor(1080, 1080)).toBe("1:1");
    expect(aspectRatioFor(1080, 1920)).toBe("9:16");
    expect(aspectRatioFor(1024, 768)).toBe("4:3");
  });

  it("falls back to 16:9 for nonsense geometry", () => {
    expect(aspectRatioFor(0, 0)).toBe("16:9");
    expect(aspectRatioFor(-5, 10)).toBe("16:9");
  });
});

describe("readApiKey", () => {
  it("prefers GEMINI_API_KEY, then GOOGLE_GENAI_API_KEY", () => {
    expect(readApiKey({ GEMINI_API_KEY: "a", GOOGLE_GENAI_API_KEY: "b" })).toBe(
      "a"
    );
    expect(readApiKey({ GOOGLE_GENAI_API_KEY: "b" })).toBe("b");
  });

  it("trims and treats blank as unset", () => {
    expect(readApiKey({ GEMINI_API_KEY: "  k  " })).toBe("k");
    expect(readApiKey({ GEMINI_API_KEY: "   " })).toBeUndefined();
    expect(readApiKey({})).toBeUndefined();
  });
});

describe("resolveMediaProviders", () => {
  it("returns Gemini providers when a key is set", () => {
    const providers = resolveMediaProviders({
      env: { GEMINI_API_KEY: "test-key" },
      log: noopLog,
    });
    expect(providers.tts).toBeDefined();
    expect(providers.titleBackground).toBeDefined();
    expect(providers.music).toBeDefined();
    expect(providers.tts?.id).toBe("gemini-tts");
    expect(providers.titleBackground?.id).toBe("gemini-image");
    expect(providers.music?.id).toBe("gemini-music");
    expect(providers.notes.length).toBeGreaterThan(0);
  });

  it("carries the session voice in the tts label (reproducibility)", () => {
    const providers = resolveMediaProviders({
      env: { GEMINI_API_KEY: "k", CANARY_TTS_VOICE: "Charon" },
      log: noopLog,
    });
    expect(providers.tts?.label).toBe("gemini:Charon");
  });

  it("returns no providers (just notes) when no key is set, without throwing", () => {
    const providers = resolveMediaProviders({ env: {}, log: noopLog });
    expect(providers.tts).toBeUndefined();
    expect(providers.titleBackground).toBeUndefined();
    expect(providers.music).toBeUndefined();
    expect(providers.notes.length).toBeGreaterThan(0);
  });

  it("does not leak the api key into the notes", () => {
    const providers = resolveMediaProviders({
      env: { GEMINI_API_KEY: "super-secret-key" },
      log: noopLog,
    });
    for (const note of providers.notes) {
      expect(note).not.toContain("super-secret-key");
    }
    expect(providers.tts?.label).not.toContain("super-secret-key");
  });
});
