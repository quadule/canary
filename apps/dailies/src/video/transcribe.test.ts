import { describe, expect, it } from "vitest";
import {
  buildTranscribeArgs,
  launchFor,
  pickGgmlModel,
  resolveOpenAiTranscriber,
  resolveWhisper,
  transcriptOutputPath,
} from "./transcribe.js";

describe("resolveOpenAiTranscriber", () => {
  it("is off without $DAILIES_TRANSCRIBE_URL", () => {
    expect(resolveOpenAiTranscriber({})).toBeNull();
  });
  it("builds the endpoint, defaults the model, and reads the key", () => {
    expect(
      resolveOpenAiTranscriber({
        DAILIES_TRANSCRIBE_URL: "http://localhost:13305/",
        DAILIES_TRANSCRIBE_MODEL: "Whisper-Large-v3-Turbo",
        DAILIES_TRANSCRIBE_API_KEY: "sk-x",
      })
    ).toEqual({
      url: "http://localhost:13305/v1/audio/transcriptions",
      model: "Whisper-Large-v3-Turbo",
      apiKey: "sk-x",
    });
    expect(
      resolveOpenAiTranscriber({ DAILIES_TRANSCRIBE_URL: "http://h:1" })?.model
    ).toBe("whisper-1");
  });
});

describe("resolveWhisper", () => {
  it("is disabled without a model path", () => {
    expect(resolveWhisper({})).toBeNull();
    expect(resolveWhisper({ DAILIES_WHISPER_MODEL: "   " })).toBeNull();
  });
  it("defaults the cli to whisper-cli and honors overrides", () => {
    expect(resolveWhisper({ DAILIES_WHISPER_MODEL: "/m/base.en.bin" })).toEqual(
      {
        cli: "whisper-cli",
        model: "/m/base.en.bin",
      }
    );
    expect(
      resolveWhisper({
        DAILIES_WHISPER_MODEL: "/m/x.bin",
        DAILIES_WHISPER_CLI: "/usr/local/bin/whisper-cli",
      })
    ).toEqual({ cli: "/usr/local/bin/whisper-cli", model: "/m/x.bin" });
  });
});

describe("pickGgmlModel", () => {
  it("prefers an English base/small build, ignores non-ggml files", () => {
    expect(
      pickGgmlModel([
        "README.md",
        "ggml-large-v3.bin",
        "ggml-small.en.bin",
        "ggml-base.en.bin",
      ])
    ).toBe("ggml-base.en.bin");
  });
  it("falls back to any ggml model when no English build exists", () => {
    expect(pickGgmlModel(["ggml-large-v3.bin"])).toBe("ggml-large-v3.bin");
  });
  it("returns undefined when there's no ggml model", () => {
    expect(pickGgmlModel(["notes.txt", "model.pt"])).toBeUndefined();
  });
});

describe("transcriptOutputPath", () => {
  it("whisper.cpp writes <outBase>.srt", () => {
    expect(
      transcriptOutputPath("whisper-cpp", {
        wav: "/t/song.wav.16k.wav",
        outDir: "/t",
        outBase: "/t/song.wav.whisper",
      })
    ).toBe("/t/song.wav.whisper.srt");
  });
  it("whisperx writes JSON (for per-word timings) named after the input", () => {
    expect(
      transcriptOutputPath("whisperx", {
        wav: "/t/song.wav.16k.wav",
        outDir: "/t",
        outBase: "/t/song.wav.whisper",
      })
    ).toBe("/t/song.wav.16k.json");
  });
  it("mlx names the srt after the input file in --output-dir", () => {
    expect(
      transcriptOutputPath("mlx-whisper", {
        wav: "/t/song.wav.16k.wav",
        outDir: "/t",
        outBase: "/t/song.wav.whisper",
      })
    ).toBe("/t/song.wav.16k.srt");
  });
});

describe("launchFor", () => {
  it("runs whisperx directly when it's on PATH", () => {
    expect(launchFor("whisperx", { hasDirect: true, hasUvx: true })).toEqual({
      cli: "whisperx",
      prefixArgs: [],
    });
  });
  it("falls back to `uvx whisperx` (with torch pins) when only uvx is present", () => {
    expect(launchFor("whisperx", { hasDirect: false, hasUvx: true })).toEqual({
      cli: "uvx",
      prefixArgs: [
        "--python",
        "3.12",
        "--with",
        "torch<2.9",
        "--with",
        "torchaudio<2.9",
        "whisperx",
      ],
    });
  });
  it("has no uvx path for whisper.cpp (a compiled binary)", () => {
    expect(
      launchFor("whisper-cpp", { hasDirect: false, hasUvx: true })
    ).toBeNull();
  });
  it("honors an override CLI, splitting args (e.g. 'uvx whisperx')", () => {
    expect(
      launchFor("whisperx", {
        overrideCli: "uvx whisperx",
        hasDirect: false,
        hasUvx: false,
      })
    ).toEqual({ cli: "uvx", prefixArgs: ["whisperx"] });
  });
  it("returns null when nothing can launch the backend", () => {
    expect(
      launchFor("mlx-whisper", { hasDirect: false, hasUvx: true })
    ).toBeNull();
  });
});

describe("buildTranscribeArgs", () => {
  const io = { wav: "/t/a.wav", outDir: "/t", outBase: "/t/a.whisper" };

  it("whisperx pins English, emits JSON (word timings), keeps its alignment pass", () => {
    const args = buildTranscribeArgs(
      { kind: "whisperx", cli: "whisperx", prefixArgs: [], model: "small.en" },
      io
    );
    expect(args).toEqual([
      "/t/a.wav",
      "--model",
      "small.en",
      "--language",
      "en",
      "--output_format",
      "json",
      "--output_dir",
      "/t",
    ]);
    // No flag disables alignment.
    expect(args).not.toContain("--no_align");
  });

  it("mlx-whisper uses its hyphenated flags and an HF repo model", () => {
    const args = buildTranscribeArgs(
      {
        kind: "mlx-whisper",
        cli: "mlx_whisper",
        prefixArgs: [],
        model: "mlx-community/whisper-small.en-mlx",
      },
      io
    );
    expect(args).toContain("--output-format");
    expect(args).toContain("--output-dir");
    expect(args).toContain("mlx-community/whisper-small.en-mlx");
  });

  it("whisper.cpp uses -m/-f/-osrt with the ggml model", () => {
    const args = buildTranscribeArgs(
      {
        kind: "whisper-cpp",
        cli: "whisper-cli",
        prefixArgs: [],
        model: "/m/ggml-base.en.bin",
      },
      io
    );
    expect(args).toEqual([
      "-m",
      "/m/ggml-base.en.bin",
      "-f",
      "/t/a.wav",
      "-l",
      "en",
      "-osrt",
      "-of",
      "/t/a.whisper",
      "--no-prints",
    ]);
  });
});
