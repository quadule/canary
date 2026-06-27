import { describe, expect, it } from "vitest";
import { resolveWhisper } from "./transcribe.js";

describe("resolveWhisper", () => {
  it("is disabled without a model path", () => {
    expect(resolveWhisper({})).toBeNull();
    expect(resolveWhisper({ CANARY_WHISPER_MODEL: "   " })).toBeNull();
  });
  it("defaults the cli to whisper-cli and honors overrides", () => {
    expect(resolveWhisper({ CANARY_WHISPER_MODEL: "/m/base.en.bin" })).toEqual({
      cli: "whisper-cli",
      model: "/m/base.en.bin",
    });
    expect(
      resolveWhisper({
        CANARY_WHISPER_MODEL: "/m/x.bin",
        CANARY_WHISPER_CLI: "/usr/local/bin/whisper-cli",
      })
    ).toEqual({ cli: "/usr/local/bin/whisper-cli", model: "/m/x.bin" });
  });
});
