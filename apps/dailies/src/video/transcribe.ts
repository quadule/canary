// Best-effort transcription of a generated song, for song-mode caption alignment.
//
// ACE-Step (and Lyria) pace and drop our lyrics unpredictably, so to time the
// captions to the ACTUAL singing we transcribe the rendered song and align our
// clean written lines to it. This is OPTIONAL: when no transcriber is found (and
// none is configured) or any step fails it returns null, and song mode falls back
// to step-timed captions. Mirrors the other providers' contract — a missing local
// tool degrades gracefully, never throws into the pipeline.
//
// BACKENDS (autodetected, English-only): any of these on PATH works, no env var
// required. Preference order — whisperx first (it runs a wav2vec2 phoneme
// forced-alignment pass for tight word timings), then mlx-whisper (Apple-Silicon,
// pulls models from the HuggingFace cache), then whisper.cpp's whisper-cli (needs
// a local ggml model, found in the HF cache or a whisper.cpp models dir). All
// three emit an `.srt`, which parseWhisperSrt already understands. Override
// detection with $DAILIES_TRANSCRIBER (whisperx|mlx-whisper|whisper-cpp),
// $DAILIES_WHISPER_CLI (binary), and $DAILIES_WHISPER_MODEL (model size/repo for
// whisperx/mlx, or a ggml path for whisper.cpp).
import { execFile } from "node:child_process";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseWhisperSrt,
  parseWhisperxJson,
  type Segment,
  segmentsFromOpenAI,
  type TimedWord,
  wordsFromOpenAI,
} from "./align.js";

// A transcription result: coarse segments (for vocal-region / tail detection) plus
// the WORD timeline when the backend can emit it (whisperx always; an OpenAI server
// asked for word granularity). Word timings drive caption alignment; segments are
// the fallback. `words` is [] when the backend is segment-only (whisper.cpp/mlx SRT).
export interface Transcript {
  segments: Segment[];
  words: TimedWord[];
}

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 300_000;
// The transcriber itself gets a longer budget than the ffmpeg convert: a cold
// `uvx whisperx` run installs the torch stack AND downloads a ~360 MB wav2vec2
// alignment model before inference, which easily exceeds 5 minutes the first
// time (subsequent runs are cached and fast).
const TRANSCRIBE_TIMEOUT_MS = 900_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const WHICH_TIMEOUT_MS = 5000;

type Echo = (line: string) => void;

export type TranscriberKind = "whisperx" | "mlx-whisper" | "whisper-cpp";

// Autodetection preference order. whisperx leads because it does phoneme-level
// forced alignment; whisper.cpp trails because it additionally needs a model file.
const KIND_ORDER: TranscriberKind[] = [
  "whisperx",
  "mlx-whisper",
  "whisper-cpp",
];

// The default CLI binary name for each backend.
const DEFAULT_CLI: Record<TranscriberKind, string> = {
  whisperx: "whisperx",
  "mlx-whisper": "mlx_whisper",
  "whisper-cpp": "whisper-cli",
};

// The default model per backend (English). whisperx takes a faster-whisper size;
// mlx-whisper takes an HF repo id; whisper.cpp needs a resolved ggml path (no
// default — see resolveWhisperCppModel).
const DEFAULT_MODEL: Partial<Record<TranscriberKind, string>> = {
  whisperx: "small.en",
  "mlx-whisper": "mlx-community/whisper-small.en-mlx",
};

// PyPI-installable backends can be run WITHOUT a PATH install via `uvx <pkg>`
// (uv's tool runner) — this is how whisperx is commonly installed. Maps the kind
// to the package name uvx should run. whisper.cpp is a compiled binary, not a
// pip package, so it has no uvx path.
const UVX_PACKAGE: Partial<Record<TranscriberKind, string>> = {
  whisperx: "whisperx",
};

// Version pins inserted before the package name for `uvx <pkg>`. A bare
// `uvx whisperx` resolves the newest torch stack (Python 3.14 + torchaudio
// >=2.9); torchaudio 2.9 dropped `list_audio_backends()`, which crashes
// whisperx's pyannote VAD import BEFORE any transcription runs
// (`AttributeError: module 'torchaudio' has no attribute
// 'list_audio_backends'`). Pin to a Python + torch that whisperx's pyannote
// dependency still works against — verified small.en end-to-end on Apple
// Silicon (the libtorchcodec dylib warning it prints is non-fatal).
const UVX_PINS: Partial<Record<TranscriberKind, string[]>> = {
  whisperx: [
    "--python",
    "3.12",
    "--with",
    "torch<2.9",
    "--with",
    "torchaudio<2.9",
  ],
};

export interface Transcriber {
  // The executable to run — usually the tool itself, but "uvx" when the tool is
  // launched via uv's runner (prefixArgs then carries the package name).
  cli: string;
  kind: TranscriberKind;
  // whisperx/mlx: a model size or HF repo id. whisper-cpp: a ggml model path.
  model: string;
  // Args inserted BEFORE the tool's own args (e.g. ["whisperx"] for `uvx whisperx`).
  prefixArgs: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no I/O).
// ---------------------------------------------------------------------------

// The transcript file a backend writes for `wav` under `outDir`/`outBase`.
// whisperx emits JSON (segments + per-word timings — see buildTranscribeArgs);
// mlx-whisper writes an `.srt` named after the INPUT file inside --output-dir;
// whisper.cpp writes `<outBase>.srt` from its `-of` flag. Pure → unit-tested.
export function transcriptOutputPath(
  kind: TranscriberKind,
  args: { wav: string; outDir: string; outBase: string }
): string {
  if (kind === "whisper-cpp") {
    return `${args.outBase}.srt`;
  }
  const stem = path.basename(args.wav).replace(/\.[^.]+$/, "");
  const ext = kind === "whisperx" ? "json" : "srt";
  return path.join(args.outDir, `${stem}.${ext}`);
}

// The CLI arguments to transcribe `wav` for English captions. whisperx runs its
// wav2vec2 forced-alignment pass (the reason it leads the order) and emits JSON so
// we get the per-WORD timings, not just segments; we only pin the language so it
// skips detection and loads the English alignment model. Pure → unit-tested.
export function buildTranscribeArgs(
  t: Transcriber,
  args: { wav: string; outDir: string; outBase: string }
): string[] {
  switch (t.kind) {
    case "whisperx":
      return [
        args.wav,
        "--model",
        t.model,
        "--language",
        "en",
        "--output_format",
        "json",
        "--output_dir",
        args.outDir,
      ];
    case "mlx-whisper":
      return [
        args.wav,
        "--model",
        t.model,
        "--language",
        "en",
        "--output-format",
        "srt",
        "--output-dir",
        args.outDir,
      ];
    default:
      return [
        "-m",
        t.model,
        "-f",
        args.wav,
        "-l",
        "en",
        "-osrt",
        "-of",
        args.outBase,
        "--no-prints",
      ];
  }
}

// How to launch a backend, given what's available: an explicit override CLI
// (may include args, e.g. "uvx whisperx"), else the direct binary on PATH, else
// `uvx <pkg>` for a pip-installable backend when uvx is present. Returns null
// when nothing can launch it. Pure → unit-tested.
export function launchFor(
  kind: TranscriberKind,
  opts: { overrideCli?: string; hasDirect: boolean; hasUvx: boolean }
): { cli: string; prefixArgs: string[] } | null {
  const override = opts.overrideCli?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cli: parts[0] ?? override, prefixArgs: parts.slice(1) };
  }
  if (opts.hasDirect) {
    return { cli: DEFAULT_CLI[kind], prefixArgs: [] };
  }
  const pkg = UVX_PACKAGE[kind];
  if (pkg && opts.hasUvx) {
    return { cli: "uvx", prefixArgs: [...(UVX_PINS[kind] ?? []), pkg] };
  }
  return null;
}

// Pick the best ggml model from a list of candidate filenames, preferring an
// English (`.en`) build and a small/base size (fast, plenty for sung lyrics).
// Pure → unit-tested.
export function pickGgmlModel(files: string[]): string | undefined {
  const bins = files.filter((f) => /^ggml-.*\.bin$/i.test(f));
  if (bins.length === 0) {
    return;
  }
  const score = (f: string): number => {
    let s = 0;
    if (/\.en\.bin$/i.test(f)) {
      s += 100; // English-only build
    }
    if (/base/i.test(f)) {
      s += 20;
    } else if (/small/i.test(f)) {
      s += 18;
    } else if (/tiny/i.test(f)) {
      s += 15;
    } else if (/medium/i.test(f)) {
      s += 8;
    }
    return s;
  };
  return [...bins].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

// ---------------------------------------------------------------------------
// Detection (I/O).
// ---------------------------------------------------------------------------

// Back-compat: the previous env-only resolver. Still honored — an explicit
// $DAILIES_WHISPER_MODEL selects the whisper.cpp backend directly. Pure → tested.
export function resolveWhisper(env: NodeJS.ProcessEnv): {
  cli: string;
  model: string;
} | null {
  const model = env.DAILIES_WHISPER_MODEL?.trim();
  if (!model) {
    return null;
  }
  return { cli: env.DAILIES_WHISPER_CLI?.trim() || "whisper-cli", model };
}

// Whether `bin` resolves on PATH (or is an absolute path that exists).
async function onPath(bin: string): Promise<boolean> {
  if (bin.includes("/")) {
    try {
      await access(bin);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    await execFileAsync(probe, [bin], { timeout: WHICH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// Find a whisper.cpp ggml model: an explicit override, else the HuggingFace cache
// (models--ggerganov--whisper.cpp/**), else a whisper.cpp models dir. Returns an
// absolute path or undefined.
async function resolveWhisperCppModel(
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const override = env.DAILIES_WHISPER_MODEL?.trim();
  if (override) {
    return override;
  }
  const home = homedir();
  // 1) HuggingFace cache: ~/.cache/huggingface/hub/models--ggerganov--whisper.cpp/snapshots/<rev>/*.bin
  const hfHub = env.HF_HOME
    ? path.join(env.HF_HOME, "hub")
    : path.join(home, ".cache", "huggingface", "hub");
  const repoDir = path.join(
    hfHub,
    "models--ggerganov--whisper.cpp",
    "snapshots"
  );
  for (const rev of await listDir(repoDir)) {
    const snap = path.join(repoDir, rev);
    const pick = pickGgmlModel(await listDir(snap));
    if (pick) {
      return path.join(snap, pick);
    }
  }
  // 2) Common whisper.cpp models dirs.
  const modelDirs = [
    path.join(home, "whisper.cpp", "models"),
    "/usr/local/share/whisper.cpp/models",
    "/opt/homebrew/share/whisper.cpp/models",
  ];
  for (const dir of modelDirs) {
    const pick = pickGgmlModel(await listDir(dir));
    if (pick) {
      return path.join(dir, pick);
    }
  }
  return;
}

// The backends to try, in order: an explicit $DAILIES_TRANSCRIBER wins, else the
// back-compat $DAILIES_WHISPER_MODEL (no kind → whisper.cpp), else the full
// autodetect order. Pure → unit-tested.
export function transcriberOrder(env: NodeJS.ProcessEnv): TranscriberKind[] {
  const forced = env.DAILIES_TRANSCRIBER?.trim() as TranscriberKind | undefined;
  if (forced && KIND_ORDER.includes(forced)) {
    return [forced];
  }
  if (env.DAILIES_WHISPER_MODEL?.trim()) {
    return ["whisper-cpp"];
  }
  return KIND_ORDER;
}

// Resolve one backend to a runnable Transcriber, or null when it isn't available
// (binary not found, or whisper.cpp with no model). `forced` is the explicit
// $DAILIES_TRANSCRIBER, used to scope the CLI override.
async function resolveKind(
  kind: TranscriberKind,
  env: NodeJS.ProcessEnv,
  forced: TranscriberKind | undefined
): Promise<Transcriber | null> {
  // A DAILIES_WHISPER_CLI override only applies when the kind is forced (or it's
  // the whisper-cpp back-compat path) — otherwise a stray override would hijack
  // an autodetected backend it wasn't meant for.
  const overrideApplies =
    forced === kind || (kind === "whisper-cpp" && !forced);
  const overrideCli = overrideApplies
    ? env.DAILIES_WHISPER_CLI?.trim() || undefined
    : undefined;
  const hasDirect = !overrideCli && (await onPath(DEFAULT_CLI[kind]));
  const hasUvx =
    !overrideCli && UVX_PACKAGE[kind] ? await onPath("uvx") : false;
  const launch = launchFor(kind, { overrideCli, hasDirect, hasUvx });
  if (!launch) {
    return null;
  }
  // Confirm an explicit override binary actually resolves.
  if (overrideCli && !(await onPath(launch.cli))) {
    return null;
  }
  const model =
    kind === "whisper-cpp"
      ? await resolveWhisperCppModel(env)
      : env.DAILIES_WHISPER_MODEL?.trim() || DEFAULT_MODEL[kind];
  return model ? { kind, ...launch, model } : null;
}

// Resolve which transcriber to use by trying transcriberOrder() and returning the
// first that's actually available; null when none is.
export async function resolveTranscriber(
  env: NodeJS.ProcessEnv
): Promise<Transcriber | null> {
  const forced = env.DAILIES_TRANSCRIBER?.trim() as TranscriberKind | undefined;
  for (const kind of transcriberOrder(env)) {
    const resolved = await resolveKind(kind, env, forced);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

// An OpenAI-compatible transcription endpoint (whisper `/v1/audio/transcriptions`
// — e.g. a Lemonade / speaches / faster-whisper-server on localhost). Preferred
// over the CLI backends when configured: it can serve a much stronger model
// (Whisper-Large-v3-Turbo) than a locally-installed whisper.cpp, which markedly
// improves song-caption alignment.
export interface OpenAiTranscriber {
  apiKey?: string;
  model: string;
  url: string; // full /v1/audio/transcriptions endpoint
}

// Resolve the OpenAI-compatible transcriber when $DAILIES_TRANSCRIBE_URL is set
// (the host root, e.g. http://localhost:13305 — the /v1/audio/transcriptions path
// is appended). $DAILIES_TRANSCRIBE_MODEL picks the model (default "whisper-1");
// $DAILIES_TRANSCRIBE_API_KEY adds a Bearer header. Pure → unit-tested.
export function resolveOpenAiTranscriber(
  env: NodeJS.ProcessEnv
): OpenAiTranscriber | null {
  const base = env.DAILIES_TRANSCRIBE_URL?.trim();
  if (!base) {
    return null;
  }
  return {
    url: `${base.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    model: env.DAILIES_TRANSCRIBE_MODEL?.trim() || "whisper-1",
    apiKey: env.DAILIES_TRANSCRIBE_API_KEY?.trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// Runner (I/O).
// ---------------------------------------------------------------------------

// Transcribe a 16 kHz wav via the OpenAI-compatible endpoint, returning cleaned
// segments (or null on any failure). Requests verbose_json so the reply carries
// per-segment start/end times. Never throws.
async function transcribeViaOpenAi(
  t: OpenAiTranscriber,
  wav: string,
  echo?: Echo
): Promise<Transcript | null> {
  echo?.(
    `$ curl -s ${t.url} -F file=@<wav> -F model=${t.model} -F response_format=verbose_json -F 'timestamp_granularities[]=word'`
  );
  const bytes = await readFile(wav);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
  form.append("model", t.model);
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  // Ask for BOTH granularities: words drive caption alignment, segments the
  // vocal-region/tail detection. A server that only does segments just returns no
  // `words` (→ we fall back to segment alignment).
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const res = await fetch(t.url, {
    method: "POST",
    headers: t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`transcription HTTP ${res.status}`);
  }
  const body = await res.json();
  const segments = segmentsFromOpenAI(body);
  const words = wordsFromOpenAI(body);
  return segments.length > 0 || words.length > 0 ? { segments, words } : null;
}

// Transcribe `audioPath` into timed segments, or null when unavailable/failed.
// Converts to 16 kHz mono first (what every backend expects), runs the resolved
// transcriber to an `.srt`, parses it, and cleans up the temps. Never throws.
export async function transcribeSong(args: {
  audioPath: string;
  ffmpeg: string;
  env: NodeJS.ProcessEnv;
  echo?: Echo;
}): Promise<Transcript | null> {
  // An OpenAI-compatible endpoint ($DAILIES_TRANSCRIBE_URL) wins over the CLI
  // backends — it can serve a far stronger model for tighter caption timing.
  const openai = resolveOpenAiTranscriber(args.env);
  const transcriber = openai ? null : await resolveTranscriber(args.env);
  if (!(openai || transcriber)) {
    return null;
  }
  const backend = openai ? "openai" : (transcriber?.kind ?? "?");
  const wav = `${args.audioPath}.16k.wav`;
  const outDir = path.dirname(args.audioPath);
  const outBase = `${args.audioPath}.whisper`;
  // Only the CLI backends write a sidecar transcript file to clean up.
  const outPath = transcriber
    ? transcriptOutputPath(transcriber.kind, { wav, outDir, outBase })
    : "";
  try {
    // Every backend wants 16 kHz mono.
    await execFileAsync(
      args.ffmpeg,
      [
        "-hide_banner",
        "-nostats",
        "-y",
        "-i",
        args.audioPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        wav,
      ],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }
    );
    if (openai) {
      return await transcribeViaOpenAi(openai, wav, args.echo);
    }
    if (!transcriber) {
      return null;
    }
    const cliArgs = [
      ...transcriber.prefixArgs,
      ...buildTranscribeArgs(transcriber, { wav, outDir, outBase }),
    ];
    args.echo?.(`$ ${transcriber.cli} ${cliArgs.join(" ")}`);
    await execFileAsync(transcriber.cli, cliArgs, {
      timeout: TRANSCRIBE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const raw = await readFile(outPath, "utf8");
    // whisperx emits JSON with per-word timings; the others emit an SRT (segments
    // only → word alignment falls back to segment matching downstream).
    if (transcriber.kind === "whisperx") {
      const { segments, words } = parseWhisperxJson(JSON.parse(raw));
      return segments.length > 0 || words.length > 0
        ? { segments, words }
        : null;
    }
    const segments = parseWhisperSrt(raw);
    return segments.length > 0 ? { segments, words: [] } : null;
  } catch (err) {
    // Transcription is optional (captions fall back to step timing), so we
    // still degrade gracefully — but surface WHY, since a silent null left
    // users guessing which backend/env-var was at fault. Show the tool's own
    // stderr tail (e.g. a missing model, a torch import crash, an HTTP error).
    const e = err as { stderr?: string; message?: string };
    const detail =
      (e.stderr ?? "").trim().split("\n").slice(-3).join(" ") ||
      e.message ||
      String(err);
    args.echo?.(
      `caption transcription (${backend}) failed, using step-timed captions: ${detail}`
    );
    return null;
  } finally {
    await rm(wav, { force: true });
    if (outPath) {
      await rm(outPath, { force: true });
    }
  }
}
