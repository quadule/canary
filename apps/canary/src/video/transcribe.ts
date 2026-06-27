// Best-effort transcription of a generated song, for song-mode caption alignment.
//
// ACE-Step paces and drops our lyrics unpredictably, so to time the captions to
// the ACTUAL singing we transcribe the rendered song with whisper.cpp's
// `whisper-cli` and a local ggml model. This is OPTIONAL: with no model
// (`$CANARY_WHISPER_MODEL` unset) or any failure it returns null, and song mode
// falls back to step-timed captions. Mirrors the other providers' contract — a
// missing local tool degrades gracefully, never throws into the pipeline.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { parseWhisperSrt, type Segment } from "./align.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 300_000;
const MAX_BUFFER = 64 * 1024 * 1024;

type Echo = (line: string) => void;

// Resolve the whisper-cli binary and model path from the environment. Returns
// null (transcription disabled) when no model is configured. Pure → unit-tested.
export function resolveWhisper(env: NodeJS.ProcessEnv): {
  cli: string;
  model: string;
} | null {
  const model = env.CANARY_WHISPER_MODEL?.trim();
  if (!model) {
    return null;
  }
  return { cli: env.CANARY_WHISPER_CLI?.trim() || "whisper-cli", model };
}

// Transcribe `audioPath` into timed segments, or null when unavailable/failed.
// Converts to 16 kHz mono first (whisper's expected input), runs whisper-cli to
// an `.srt`, parses it, and cleans up the temps. Never throws.
export async function transcribeSong(args: {
  audioPath: string;
  ffmpeg: string;
  env: NodeJS.ProcessEnv;
  echo?: Echo;
}): Promise<Segment[] | null> {
  const resolved = resolveWhisper(args.env);
  if (!resolved) {
    return null;
  }
  const { cli, model } = resolved;
  const wav = `${args.audioPath}.16k.wav`;
  const outBase = `${args.audioPath}.whisper`;
  const srtPath = `${outBase}.srt`;
  try {
    await execFileAsync(
      args.ffmpeg,
      ["-hide_banner", "-nostats", "-y", "-i", args.audioPath, "-ar", "16000", "-ac", "1", wav],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }
    );
    args.echo?.(`$ ${cli} -m ${model} -f ${wav} -osrt`);
    await execFileAsync(
      cli,
      ["-m", model, "-f", wav, "-osrt", "-of", outBase, "--no-prints"],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }
    );
    const srt = await readFile(srtPath, "utf8");
    const segments = parseWhisperSrt(srt);
    return segments.length > 0 ? segments : null;
  } catch {
    return null;
  } finally {
    await rm(wav, { force: true });
    await rm(srtPath, { force: true });
  }
}
