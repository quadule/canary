import { describe, expect, it } from "vitest";
import {
  aspectRatioFor,
  buildImagePrompt,
  buildInteractionBody,
  buildMusicPrompt,
  buildTtsPrompt,
  extractInteractionMedia,
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

describe("extractInteractionMedia", () => {
  it("finds an audio block in steps[].content[]", () => {
    const payload = Buffer.from("hello media");
    const body = {
      steps: [
        {
          content: [
            { type: "text", text: "here is your audio" },
            {
              type: "audio",
              mime_type: "audio/L16;rate=24000",
              data: payload.toString("base64"),
            },
          ],
        },
      ],
    };
    const found = extractInteractionMedia(body, "audio");
    expect(found).not.toBeNull();
    expect(found?.bytes.equals(payload)).toBe(true);
    expect(found?.mimeType).toBe("audio/L16;rate=24000");
  });

  it("finds an image block and ignores audio blocks when image is wanted", () => {
    const img = Buffer.from("img");
    const audio = Buffer.from("aud");
    const body = {
      steps: [
        {
          content: [
            {
              type: "audio",
              mime_type: "audio/mpeg",
              data: audio.toString("base64"),
            },
            {
              type: "image",
              mime_type: "image/png",
              data: img.toString("base64"),
            },
          ],
        },
      ],
    };
    const found = extractInteractionMedia(body, "image");
    expect(found?.bytes.equals(img)).toBe(true);
    expect(found?.mimeType).toBe("image/png");
  });

  it("reads the convenience output_image / output_audio fields", () => {
    const img = Buffer.from("conv-image");
    expect(
      extractInteractionMedia(
        {
          output_image: {
            mime_type: "image/jpeg",
            data: img.toString("base64"),
          },
        },
        "image"
      )?.bytes.equals(img)
    ).toBe(true);

    const aud = Buffer.from("conv-audio");
    const foundAudio = extractInteractionMedia(
      {
        output_audio: { mime_type: "audio/mpeg", data: aud.toString("base64") },
      },
      "audio"
    );
    expect(foundAudio?.bytes.equals(aud)).toBe(true);
    expect(foundAudio?.mimeType).toBe("audio/mpeg");
  });

  it("unwraps a top-level `interaction` envelope if present", () => {
    const img = Buffer.from("wrapped-image");
    const body = {
      interaction: {
        steps: [
          {
            content: [
              {
                type: "image",
                mime_type: "image/png",
                data: img.toString("base64"),
              },
            ],
          },
        ],
      },
    };
    expect(extractInteractionMedia(body, "image")?.bytes.equals(img)).toBe(
      true
    );
  });

  it("returns null when the wanted media type is absent or malformed", () => {
    expect(extractInteractionMedia(null, "image")).toBeNull();
    expect(extractInteractionMedia({}, "audio")).toBeNull();
    expect(extractInteractionMedia({ steps: [] }, "image")).toBeNull();
    // Only a text block present → no audio.
    expect(
      extractInteractionMedia(
        { steps: [{ content: [{ type: "text", text: "x" }] }] },
        "audio"
      )
    ).toBeNull();
    // Right type but empty data → not usable.
    expect(
      extractInteractionMedia(
        { steps: [{ content: [{ type: "image", data: "" }] }] },
        "image"
      )
    ).toBeNull();
    // Wanting image but only audio present.
    expect(
      extractInteractionMedia(
        { output_audio: { data: Buffer.from("a").toString("base64") } },
        "image"
      )
    ).toBeNull();
  });
});

describe("buildInteractionBody", () => {
  it("builds an image request with model, string input, and response_format", () => {
    const body = buildInteractionBody({
      model: "gemini-3.1-flash-image",
      input: "a cinematic background",
      responseFormat: { type: "image", aspect_ratio: "16:9" },
    });
    expect(body.model).toBe("gemini-3.1-flash-image");
    expect(body.input).toBe("a cinematic background");
    expect(body.response_format).toEqual({
      type: "image",
      aspect_ratio: "16:9",
    });
    // No speech config for non-TTS requests.
    expect(body.generation_config).toBeUndefined();
  });

  it("builds a TTS request with speech_config voice array", () => {
    const body = buildInteractionBody({
      model: "gemini-3.1-flash-tts-preview",
      input: "Read this aloud: hi",
      responseFormat: { type: "audio" },
      speechVoice: "Charon",
    });
    expect(body.model).toBe("gemini-3.1-flash-tts-preview");
    expect(body.response_format).toEqual({ type: "audio" });
    expect(body.generation_config).toEqual({
      speech_config: [{ voice: "Charon" }],
    });
  });

  it("builds an audio (music) request without speech config", () => {
    const body = buildInteractionBody({
      model: "lyria-3-clip-preview",
      input: "an instrumental score",
      responseFormat: { type: "audio" },
    });
    expect(body.model).toBe("lyria-3-clip-preview");
    expect(body.response_format).toEqual({ type: "audio" });
    expect(body.generation_config).toBeUndefined();
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

  it("embeds supplied lyrics for a song (song mode)", () => {
    const prompt = buildMusicPrompt(
      "upbeat pop montage",
      45,
      true,
      "[chorus]\nCanary sings"
    );
    expect(prompt).toContain("Sing these exact lyrics:");
    expect(prompt).toContain("[chorus]\nCanary sings");
  });

  it("omits the lyrics line for an instrumental bed even if lyrics are passed", () => {
    const prompt = buildMusicPrompt("noir", 30, false, "[verse]\nwords");
    expect(prompt).not.toContain("Sing these exact lyrics:");
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
