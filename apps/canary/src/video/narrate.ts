// Cinematic post-processing for session videos (opt-in via `canary session end
// --cinematic`). After condensing, this turns a silent screen recording into a
// narrated short: an LLM (`claude -p`) writes themed narration for each step,
// macOS `say` reads it aloud, and ffmpeg re-times the video so each step holds
// its frame long enough for its narration (clips never overlap), prepends an
// opening title card, mixes the narration in, and (optionally) burns matching
// captions. A sibling `.srt` is always written for soft-sub players.
//
// Everything here is best-effort and gated: the pipeline only runs on macOS
// (it needs `say`), only when `claude` and `say` are on PATH, and any failure
// — a missing binary, an ffmpeg error, malformed LLM output — leaves the
// original video untouched and returns { applied:false }. Non-cinematic output
// is therefore byte-identical to before.
//
// Subprocess style mirrors condense.ts: a single promisified `execFile`
// (`node:child_process`, NOT execa — not a dependency) with a bumped maxBuffer
// and a timeout on every spawn. Temp files are siblings of the video and are
// all cleaned up in a finally, even on partial failure.
import { execFile } from "node:child_process";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@usecanary/logger";
import { type StyleId, selectStyle, selectThemes } from "./themes.js";

const execFileAsync = promisify(execFile);

// Opening title-card length, prepended to the front of the video. Every
// narration/caption offset is shifted by this so the on-screen step still lines
// up with its audio. The caller adds it to each step's report timeline too.
export const TITLE_SEC = 2.5;

// macOS Premium English voices. One is picked per session (consistency) via
// Math.random or $CANARY_SAY_VOICE.
const PREMIUM_VOICES = [
  "Ava",
  "Evan",
  "Karen",
  "Moira",
  "Nathan",
  "Nicky",
  "Noelle",
  "Samantha",
  "Serena",
  "Susan",
  "Tom",
  "Victoria",
  "Zoe",
] as const;

// `say` speaking rate (words per minute). Default tuned for intelligibility;
// overridable via $CANARY_SAY_RATE.
const DEFAULT_SAY_RATE = 175;

// macOS ffmpeg is usually built without fontconfig, so drawtext needs an
// explicit font file rather than a font name.
const TITLE_FONT_FILE = "/System/Library/Fonts/Helvetica.ttc";

// Timeouts (ms). The LLM call is generous; `say` and the encodes are bounded
// like condense's encode pass.
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const LLM_TIMEOUT_MS = 120_000;
const SAY_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const ENCODE_TIMEOUT_MS = 300_000;

// Max characters of a step's script we feed the LLM — enough for context
// without bloating the prompt.
const SCRIPT_SLICE_CHARS = 200;

export interface CinematicStep {
  durationMs: number;
  name: string;
  script?: string;
  // Step position in the CONDENSED video, seconds (before the title card is
  // prepended).
  videoTime: number;
}

export interface CinematicOptions {
  // false when --no-captions: the .srt is still written, only the burn is
  // skipped.
  captions: boolean;
  ffmpegPath: string;
  log: Logger;
  // Verbatim user override (--theme); when set, skip the random draw and the
  // style modifier.
  theme?: string;
}

export interface CinematicResult {
  applied: boolean;
  // User-facing degradation notes when the pass applied but this ffmpeg build
  // couldn't do everything (e.g. no drawtext → no title card; no subtitles →
  // soft-sub .srt only). The caller surfaces these so the user isn't left
  // wondering where the title card / captions went.
  notes?: string[];
  // Why it was skipped, for logging.
  reason?: string;
  // Each input step's NEW position (seconds) in the cinematic video, including
  // the title-card offset. Re-timing (per-step freezes) moves the steps, so the
  // caller REPLACES step.videoTime with these rather than adding an offset.
  // Same order/length as the `steps` passed in. Present only when applied.
  stepTimes?: number[];
  // Seconds prepended at the front of the video by the title card (0 when the
  // card was skipped). Informational; stepTimes already includes it.
  titleOffsetSec: number;
}

interface NarrationStep {
  index: number;
  narration: string;
}

interface Narration {
  steps: NarrationStep[];
  title: string;
}

interface ProbedVideo {
  frameRate: number;
  height: number;
  width: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested). No I/O, no subprocesses.
// ---------------------------------------------------------------------------

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// Format seconds as an SRT timestamp "HH:MM:SS,mmm" (comma before the
// milliseconds, all fields zero-padded). Handles sub-second and >1h values;
// negatives clamp to zero.
export function secToSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const seconds = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const minutes = totalMin % 60;
  const hours = Math.floor(totalMin / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(ms, 3)}`;
}

// Build a valid multi-cue SRT document from timed cues. Cue numbers are
// 1-based; each cue is "<n>\n<start> --> <end>\n<text>\n\n".
export function buildSrt(
  cues: { start: number; end: number; text: string }[]
): string {
  return cues
    .map((cue, i) => {
      const start = secToSrtTimestamp(cue.start);
      const end = secToSrtTimestamp(cue.end);
      return `${i + 1}\n${start} --> ${end}\n${cue.text}\n`;
    })
    .join("\n");
}

// Build the ffmpeg `filter_complex` that delays each narration clip to its
// position on the timeline and mixes them into one stereo track [aout].
// Audio inputs are ffmpeg indices 1..N (input 0 is the video). Returns "" when
// there are no audio inputs (caller should then skip the mix entirely).
export function buildAdelayMix(offsetsMs: number[]): string {
  if (offsetsMs.length === 0) {
    return "";
  }
  const delays = offsetsMs
    .map((ms, i) => `[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`)
    .join(";");
  const labels = offsetsMs.map((_, i) => `[a${i}]`).join("");
  return `${delays};${labels}amix=inputs=${offsetsMs.length}:normalize=0[aout]`;
}

// Build the `claude -p` prompt: theme(s), the style directive, the step list,
// and a strict-JSON output contract. Deterministic given its inputs (testable).
export function buildNarrationPrompt(args: {
  themes: string[];
  style: StyleId;
  steps: { index: number; name: string; script?: string }[];
}): string {
  const { themes, style, steps } = args;
  const themeLine =
    themes.length === 1
      ? `Theme: ${themes[0]}`
      : `Themes (mix and match for the best effect): ${themes.join("; ")}`;
  const stepLines = steps
    .map((step) => {
      const slice = step.script?.slice(0, SCRIPT_SLICE_CHARS).trim();
      const scriptPart = slice ? ` — does: ${slice}` : "";
      return `  ${step.index}. ${step.name}${scriptPart}`;
    })
    .join("\n");

  return [
    "You are scripting voiceover narration for a screen-recording of an automated browser QA session.",
    "Narrate it as a short cinematic piece, fully in character for the theme.",
    "",
    themeLine,
    `Style: ${STYLE_DIRECTIVES[style]}`,
    "",
    "Steps (each is one moment in the video, in order):",
    stepLines,
    "",
    "Rules:",
    "- Write one narration entry per step: SHORT and PUNCHY, 1-2 sentences max, tight enough to be read aloud within the step's brief on-screen window. Favor brevity over flourish.",
    "- Stay in character for the theme throughout; commit to the bit.",
    "- Never repeat the literal step name; describe what is happening in the theme's voice.",
    "- Apply the style directive (for poem/limerick/haiku/song variants, the narration text should take that form).",
    '- Provide a punchy, dramatic, mostly-uppercase "title" for an opening title card.',
    "",
    'Respond with STRICT JSON only — no prose, no markdown fences — exactly: {"title": string, "steps": [{"index": number, "narration": string}]}',
  ].join("\n");
}

const STYLE_DIRECTIVES: Record<StyleId, string> = {
  prose: "natural prose narration.",
  poem: "write the narration as short free-verse poetry.",
  limerick: "write the narration as limericks (AABBA).",
  haiku: "write the narration as haiku (5-7-5 syllables).",
  song_verse: "write the narration as sung verse, like song lyrics.",
};

// Parse the LLM response into a validated Narration, or null on any problem.
// Strips ```json fences, JSON.parses, and checks the shape defensively so a
// malformed reply degrades to "skip" rather than throwing.
export function parseNarrationJson(raw: string): Narration | null {
  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== "string" || !Array.isArray(record.steps)) {
    return null;
  }
  const steps: NarrationStep[] = [];
  for (const entry of record.steps) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const stepRecord = entry as Record<string, unknown>;
    if (
      typeof stepRecord.index !== "number" ||
      typeof stepRecord.narration !== "string"
    ) {
      return null;
    }
    steps.push({ index: stepRecord.index, narration: stepRecord.narration });
  }
  return { title: record.title, steps };
}

// Parse the voice names from `say -v '?'` output. Each line is
// "<Name> (Quality)?   <locale>   # sample"; the usable `-v` name is the first
// whitespace-delimited token (e.g. "Ava" from "Ava (Premium)").
export function parseInstalledVoiceNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Subprocess helpers (generalized from condense's runFfmpeg).
// ---------------------------------------------------------------------------

// Run a command and return its stdout/stderr. Bumped maxBuffer and a hard
// timeout, like condense's runFfmpeg. Throws on non-zero exit / timeout — every
// caller is inside cinematicProcess's try/catch.
async function run(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

// Is a binary callable on PATH? Best-effort probe used for preconditions.
async function isOnPath(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, VERSION_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

// Parse a "Duration: HH:MM:SS.ms" line out of ffmpeg's `-i` stderr.
function parseDurationFromStderr(stderr: string): number | undefined {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) {
    return;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (
    !(
      Number.isFinite(hours) &&
      Number.isFinite(minutes) &&
      Number.isFinite(seconds)
    )
  ) {
    return;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

// Measure an audio clip's duration in seconds: ffprobe if present, else the
// ffmpeg `-i` stderr Duration line (mirrors condense relying on ffmpeg for
// timing when a dedicated probe isn't available).
async function audioDurationSec(
  ffmpeg: string,
  filePath: string
): Promise<number | undefined> {
  const ffprobe = ffprobeFor(ffmpeg);
  try {
    const { stdout } = await run(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      PROBE_TIMEOUT_MS
    );
    const value = Number(stdout.trim());
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  } catch {
    // ffprobe missing or failed — fall through to ffmpeg stderr.
  }
  try {
    const { stderr } = await run(
      ffmpeg,
      ["-hide_banner", "-i", filePath],
      PROBE_TIMEOUT_MS
    );
    return parseDurationFromStderr(stderr);
  } catch (err) {
    // `ffmpeg -i` with no output exits non-zero but still prints Duration.
    if (err instanceof Error && "stderr" in err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return parseDurationFromStderr(stderr);
    }
    return;
  }
}

// ffprobe normally sits beside ffmpeg with the same name suffix.
function ffprobeFor(ffmpeg: string): string {
  const dir = path.dirname(ffmpeg);
  const base = path.basename(ffmpeg);
  if (base.startsWith("ffmpeg")) {
    return path.join(dir, base.replace("ffmpeg", "ffprobe"));
  }
  return "ffprobe";
}

// Probe the source video's geometry so the title card can be encoded to match
// (so the concat demuxer can stream-copy). r_frame_rate comes back as a
// fraction like "30/1".
async function probeVideo(
  ffmpeg: string,
  videoPath: string
): Promise<ProbedVideo | undefined> {
  const ffprobe = ffprobeFor(ffmpeg);
  try {
    const { stdout } = await run(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate",
        "-of",
        "default=noprint_wrappers=1",
        videoPath,
      ],
      PROBE_TIMEOUT_MS
    );
    const width = Number(stdout.match(/width=(\d+)/)?.[1]);
    const height = Number(stdout.match(/height=(\d+)/)?.[1]);
    const frameRate = parseFrameRate(
      stdout.match(/r_frame_rate=([\d/]+)/)?.[1]
    );
    if (width > 0 && height > 0 && frameRate > 0) {
      return { width, height, frameRate };
    }
  } catch {
    // no ffprobe — caller falls back to a default geometry.
  }
  return;
}

// The set of filters this ffmpeg build supports. Minimal builds — notably
// Playwright's bundled ffmpeg — omit drawtext (title card) and subtitles
// (caption burn); even some Homebrew builds lack drawtext when compiled without
// freetype. We probe so the pipeline can do as much as the build allows instead
// of failing wholesale.
export function parseFilterNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Filter rows look like " T. adelay   A->A   Delay…"; the I/O column
    // ("A->A", "N->N", "VV->V") marks a real row. The name is the 2nd token.
    if (!line.includes("->")) {
      continue;
    }
    const name = line.trim().split(/\s+/)[1];
    if (name && /^[a-z0-9_]+$/i.test(name)) {
      names.add(name);
    }
  }
  return names;
}

async function availableFilters(ffmpeg: string): Promise<Set<string>> {
  try {
    const { stdout } = await run(
      ffmpeg,
      ["-hide_banner", "-filters"],
      VERSION_PROBE_TIMEOUT_MS
    );
    return parseFilterNames(stdout);
  } catch {
    return new Set();
  }
}

function parseFrameRate(fraction: string | undefined): number {
  if (!fraction) {
    return 0;
  }
  const parts = fraction.split("/").map(Number);
  const num = parts[0] ?? 0;
  if (!(Number.isFinite(num) && num > 0)) {
    return 0;
  }
  const den = parts[1];
  if (den === undefined) {
    return num;
  }
  if (!(Number.isFinite(den) && den > 0)) {
    return 0;
  }
  return num / den;
}

// ---------------------------------------------------------------------------
// Pipeline stages (each guarded by cinematicProcess's try/catch + best-effort).
// ---------------------------------------------------------------------------

// List the voices `say` can actually use on this host, or null if `say` is
// missing/unusable. Used both as the precondition probe and to constrain the
// voice pick to installed voices (premium voices need a manual download, so a
// hardcoded name may not be present).
async function listSayVoices(): Promise<Set<string> | null> {
  try {
    const { stdout } = await run("say", ["-v", "?"], VERSION_PROBE_TIMEOUT_MS);
    return parseInstalledVoiceNames(stdout);
  } catch {
    return null;
  }
}

// Pick the session voice. An explicit $CANARY_SAY_VOICE always wins (the user
// asked for it; let `say` error loudly if it's wrong). Otherwise choose randomly
// from the premium voices that are actually installed, falling back to any
// installed English voice, then to "Samantha" (ships by default) — so a fresh
// Mac without the premium downloads still narrates instead of silently skipping.
function pickVoice(installed: Set<string>): string {
  const override = process.env.CANARY_SAY_VOICE;
  if (override) {
    return override;
  }
  const candidates = PREMIUM_VOICES.filter((v) => installed.has(v));
  if (candidates.length > 0) {
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? candidates[0] ?? "Samantha";
  }
  if (installed.has("Samantha")) {
    return "Samantha";
  }
  const first = [...installed][0];
  return first ?? "Samantha";
}

function pickRate(): number {
  const override = Number(process.env.CANARY_SAY_RATE);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_SAY_RATE;
}

// Resolve the theme(s) and style: a verbatim --theme override uses plain prose,
// otherwise draw distinct random themes and a weighted style.
function resolveThemeAndStyle(themeOverride: string | undefined): {
  themes: string[];
  style: StyleId;
} {
  if (themeOverride) {
    return { themes: [themeOverride], style: "prose" };
  }
  return {
    themes: selectThemes(3).map((theme) => theme.label),
    style: selectStyle(),
  };
}

// Ask the LLM for narration JSON, or null on any failure.
async function generateNarration(
  prompt: string,
  log: Logger
): Promise<Narration | null> {
  let stdout: string;
  try {
    ({ stdout } = await run("claude", ["-p", prompt], LLM_TIMEOUT_MS));
  } catch (err) {
    log.debug({ err }, "cinematic: claude narration call failed");
    return null;
  }
  const narration = parseNarrationJson(stdout);
  if (!narration) {
    log.debug({ stdout }, "cinematic: could not parse narration JSON");
  }
  return narration;
}

interface RenderedClip {
  durationSec: number;
  m4aPath: string;
  narration: string;
  step: CinematicStep;
}

// Synthesize one narration clip with `say`, transcode to AAC/m4a, and probe its
// duration (for caption end-times). Pushes its temps for cleanup. Returns null
// if the clip can't be produced.
async function renderClip(args: {
  ffmpeg: string;
  voice: string;
  rate: number;
  step: CinematicStep;
  narration: string;
  videoPath: string;
  index: number;
  temps: string[];
}): Promise<RenderedClip | null> {
  const { ffmpeg, voice, rate, step, narration, videoPath, index, temps } =
    args;
  const aiffPath = `${videoPath}.step${index}.aiff`;
  const m4aPath = `${videoPath}.step${index}.m4a`;
  temps.push(aiffPath, m4aPath);

  await run(
    "say",
    ["-v", voice, "-r", String(rate), narration, "-o", aiffPath],
    SAY_TIMEOUT_MS
  );
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      aiffPath,
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "aac",
      m4aPath,
    ],
    ENCODE_TIMEOUT_MS
  );
  const durationSec = await audioDurationSec(ffmpeg, m4aPath);
  if (durationSec === undefined || durationSec <= 0) {
    return null;
  }
  return { step, narration, m4aPath, durationSec };
}

// Synthesize a clip for every step that the LLM gave narration text. The step's
// enumerated index keys the narration map (same indexing the prompt used). A
// step the LLM skipped, or one whose audio can't be produced, is just omitted.
async function synthesizeClips(args: {
  ffmpeg: string;
  voice: string;
  rate: number;
  steps: CinematicStep[];
  byIndex: Map<number, string>;
  videoPath: string;
  temps: string[];
}): Promise<RenderedClip[]> {
  const { ffmpeg, voice, rate, steps, byIndex, videoPath, temps } = args;
  const clips: RenderedClip[] = [];
  for (const [i, step] of steps.entries()) {
    const text = byIndex.get(i)?.trim();
    if (!text) {
      continue;
    }
    const clip = await renderClip({
      ffmpeg,
      voice,
      rate,
      step,
      narration: text,
      videoPath,
      index: i,
      temps,
    });
    if (clip) {
      clips.push(clip);
    }
  }
  return clips;
}

// Render a black 2.5s title card matching the source geometry, encoded to webm
// (libvpx) so the concat demuxer can stream-copy it ahead of the body.
async function buildTitleCard(args: {
  ffmpeg: string;
  title: string;
  geometry: ProbedVideo;
  outPath: string;
}): Promise<void> {
  const { ffmpeg, title, geometry, outPath } = args;
  const fontSize = Math.max(24, Math.round(geometry.height / 12));
  const escaped = escapeDrawText(title);
  const drawtext = [
    `fontfile=${TITLE_FONT_FILE}`,
    `text='${escaped}'`,
    "fontcolor=white",
    `fontsize=${fontSize}`,
    "x=(w-text_w)/2",
    "y=(h-text_h)/2",
  ].join(":");
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${geometry.width}x${geometry.height}:r=${geometry.frameRate}:d=${TITLE_SEC}`,
      "-vf",
      `drawtext=${drawtext}`,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// drawtext is sensitive to colons, single quotes, backslashes and percent.
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

// Concat the title card and the condensed body (both libvpx/webm → stream copy)
// into one video-only track.
async function concatTitleAndBody(args: {
  ffmpeg: string;
  titlePath: string;
  bodyPath: string;
  outPath: string;
  listPath: string;
}): Promise<void> {
  const { ffmpeg, titlePath, bodyPath, outPath, listPath } = args;
  const list = [titlePath, bodyPath]
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listPath, `${list}\n`);
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// Re-encode one [startSec, startSec+durSec) slice of the source, optionally
// freezing its last frame for `holdSec` more (tpad clone) so a step lingers
// while its narration finishes. Re-encoded (not stream-copied) so the slice is
// frame-accurate and all segments share codec params for a clean concat.
async function encodeSlice(args: {
  ffmpeg: string;
  src: string;
  startSec: number;
  durSec: number;
  holdSec: number;
  outPath: string;
}): Promise<void> {
  const { ffmpeg, src, startSec, durSec, holdSec, outPath } = args;
  const filter =
    holdSec > 0
      ? ["-vf", `tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}`]
      : [];
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-ss",
      startSec.toFixed(3),
      "-t",
      durSec.toFixed(3),
      "-i",
      src,
      ...filter,
      "-an",
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// Concat N stream-copyable segments (all libvpx/webm here) in order.
async function concatSegments(
  ffmpeg: string,
  paths: string[],
  outPath: string,
  listPath: string
): Promise<void> {
  const list = paths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listPath, `${list}\n`);
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// Compute, for each step (sorted by videoTime), where its footage now begins in
// the re-timed video and how long to freeze its tail. A step's natural footage
// is [videoTime, nextVideoTime) (last step runs to the end); when its narration
// is longer than that, the difference is added as a freeze hold so narration
// never bleeds into the next step. Pure → unit-tested.
export function planRetime(args: {
  stepTimes: number[];
  clipDurSec: number[];
  totalSec: number;
}): { starts: number[]; footage: number[]; holds: number[]; leadSec: number } {
  const { stepTimes, clipDurSec, totalSec } = args;
  const n = stepTimes.length;
  const starts: number[] = [];
  const footage: number[] = [];
  const holds: number[] = [];
  const leadSec = n > 0 ? Math.max(0, stepTimes[0] ?? 0) : 0;
  let acc = leadSec;
  for (let i = 0; i < n; i++) {
    const start = stepTimes[i] ?? 0;
    const next = i < n - 1 ? (stepTimes[i + 1] ?? totalSec) : totalSec;
    const f = Math.max(0.1, next - start);
    const hold = Math.max(0, (clipDurSec[i] ?? 0) - f);
    starts.push(acc);
    footage.push(f);
    holds.push(hold);
    acc += f + hold;
  }
  return { starts, footage, holds, leadSec };
}

// Re-time the video so each step holds its frame long enough for its narration.
// Returns the new video path and each step's new start (pre-title-card). Null if
// the source duration can't be probed.
async function retimeForNarration(args: {
  ffmpeg: string;
  videoPath: string;
  steps: CinematicStep[];
  clipDurSec: number[];
  temps: string[];
}): Promise<{ path: string; starts: number[] } | null> {
  const { ffmpeg, videoPath, steps, clipDurSec, temps } = args;
  const totalSec = await audioDurationSec(ffmpeg, videoPath);
  if (totalSec === undefined || totalSec <= 0) {
    return null;
  }
  const plan = planRetime({
    stepTimes: steps.map((s) => s.videoTime),
    clipDurSec,
    totalSec,
  });
  const segs: string[] = [];
  if (plan.leadSec > 0.01) {
    const leadPath = `${videoPath}.lead.webm`;
    temps.push(leadPath);
    await encodeSlice({
      ffmpeg,
      src: videoPath,
      startSec: 0,
      durSec: plan.leadSec,
      holdSec: 0,
      outPath: leadPath,
    });
    segs.push(leadPath);
  }
  for (let i = 0; i < steps.length; i++) {
    const segPath = `${videoPath}.rseg${i}.webm`;
    temps.push(segPath);
    await encodeSlice({
      ffmpeg,
      src: videoPath,
      startSec: steps[i]?.videoTime ?? 0,
      durSec: plan.footage[i] ?? 0.1,
      holdSec: plan.holds[i] ?? 0,
      outPath: segPath,
    });
    segs.push(segPath);
  }
  const outPath = `${videoPath}.retimed.webm`;
  const listPath = `${videoPath}.retime.txt`;
  temps.push(outPath, listPath);
  await concatSegments(ffmpeg, segs, outPath, listPath);
  return { path: outPath, starts: plan.starts };
}

// Build the title card matched to the source geometry and concat it ahead of the
// body, returning the new (title-prefixed) video path. Pushes its temps for
// cleanup. Only called when this ffmpeg has the drawtext filter.
async function prependTitleCard(args: {
  ffmpeg: string;
  videoPath: string;
  title: string;
  temps: string[];
}): Promise<string> {
  const { ffmpeg, videoPath, title, temps } = args;
  const geometry = (await probeVideo(ffmpeg, videoPath)) ?? {
    width: 1280,
    height: 720,
    frameRate: 30,
  };
  const titlePath = `${videoPath}.title.webm`;
  temps.push(titlePath);
  await buildTitleCard({ ffmpeg, title, geometry, outPath: titlePath });
  const concatPath = `${videoPath}.concat.webm`;
  const listPath = `${videoPath}.concat.txt`;
  temps.push(concatPath, listPath);
  await concatTitleAndBody({
    ffmpeg,
    titlePath,
    bodyPath: videoPath,
    outPath: concatPath,
    listPath,
  });
  return concatPath;
}

// Final pass: mix the delayed narration clips onto the concatenated video and
// optionally burn captions. Captions force a video re-encode (libass), so the
// no-caption branch can stream-copy the video track.
async function mixAudioAndCaptions(args: {
  ffmpeg: string;
  videoPath: string;
  clips: RenderedClip[];
  offsetsSec: number[];
  srtPath: string;
  burnCaptions: boolean;
  outPath: string;
}): Promise<void> {
  const {
    ffmpeg,
    videoPath,
    clips,
    offsetsSec,
    srtPath,
    burnCaptions,
    outPath,
  } = args;
  const offsetsMs = offsetsSec.map((s) => Math.round(s * 1000));
  const filter = buildAdelayMix(offsetsMs);

  const inputs = ["-i", videoPath];
  for (const clip of clips) {
    inputs.push("-i", clip.m4aPath);
  }

  const filterComplex = burnCaptions
    ? `${filter};[0:v]subtitles=${escapeSubtitlesPath(srtPath)}:force_style='${SUBTITLE_STYLE}'[vout]`
    : filter;

  const videoMap = burnCaptions ? "[vout]" : "0:v";
  const videoCodec = burnCaptions
    ? ["-c:v", "libvpx", "-b:v", "1M"]
    : ["-c:v", "copy"];

  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      videoMap,
      "-map",
      "[aout]",
      ...videoCodec,
      // The output container is WebM, whose muxer accepts only Opus/Vorbis
      // audio (it hard-rejects AAC) — so the mixed track is encoded to Opus
      // here. The per-step .m4a transcode stays AAC: that's an MP4 container.
      "-c:a",
      "libopus",
      outPath,
    ],
    ENCODE_TIMEOUT_MS
  );
}

// libass force_style: white text in a semi-transparent dark box, bottom third.
// BorderStyle=3 is libass's opaque-box mode (1=outline, 3=box); only 3 paints
// BackColour as a box behind the text. The AA alpha byte gives a semi-
// transparent dark fill (&H in libass ABGR; AA=alpha, 00=opaque).
const SUBTITLE_STYLE =
  "FontSize=18,PrimaryColour=&H00FFFFFF,BorderStyle=3,BackColour=&HA0000000,Alignment=2,MarginV=40";

// The subtitles filter's path argument needs colons and backslashes escaped.
function escapeSubtitlesPath(srtPath: string): string {
  return srtPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function srtPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.srt`;
}

function notApplied(reason: string): CinematicResult {
  return { applied: false, titleOffsetSec: 0, reason };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

// Overwrites `videoPath` IN PLACE with the cinematic cut (title card prepended,
// narration mixed in, captions optionally burned). Always writes a sibling
// `.srt`. Never throws: any failure leaves the original video untouched and
// returns { applied:false, titleOffsetSec:0, reason }.
export async function cinematicProcess(
  videoPath: string,
  steps: CinematicStep[],
  options: CinematicOptions
): Promise<CinematicResult> {
  const { ffmpegPath, log } = options;
  // Temps are all siblings of videoPath; the finally removes them even on a
  // partial failure (mirrors condense.ts).
  const temps: string[] = [];

  try {
    // 1. Preconditions.
    if (process.platform !== "darwin") {
      return notApplied("cinematic narration needs macOS `say`");
    }
    const narratableSteps = steps.filter((step) =>
      Number.isFinite(step.videoTime)
    );
    if (narratableSteps.length === 0) {
      return notApplied("no steps with a known video position");
    }
    await access(videoPath);
    if (!(await isOnPath("claude", ["--version"]))) {
      return notApplied("`claude` CLI not found on PATH");
    }
    const installedVoices = await listSayVoices();
    if (!installedVoices) {
      return notApplied("`say` not found on PATH");
    }
    // Narration mixing is the irreducible core; the title card and burned
    // captions degrade gracefully when this build lacks their filters.
    const filters = await availableFilters(ffmpegPath);
    if (!(filters.has("adelay") && filters.has("amix"))) {
      return notApplied("ffmpeg lacks the adelay/amix filters for narration");
    }
    const hasDrawtext = filters.has("drawtext");
    const hasSubtitles = filters.has("subtitles");
    const notes: string[] = [];

    // 2. Theme + style.
    const { themes, style } = resolveThemeAndStyle(options.theme);

    // 3. Narration via claude -p.
    const prompt = buildNarrationPrompt({
      themes,
      style,
      steps: narratableSteps.map((step, index) => ({
        index,
        name: step.name,
        script: step.script,
      })),
    });
    const narration = await generateNarration(prompt, log);
    if (!narration) {
      return notApplied("narration generation failed");
    }

    // 4. Voice + TTS: one clip per step that got narration text.
    const voice = pickVoice(installedVoices);
    const clips = await synthesizeClips({
      ffmpeg: ffmpegPath,
      voice,
      rate: pickRate(),
      steps: narratableSteps,
      byIndex: new Map(narration.steps.map((s) => [s.index, s.narration])),
      videoPath,
      temps,
    });
    if (clips.length === 0) {
      return notApplied("no narration audio could be synthesized");
    }

    // 5. Re-time: freeze each step's frame long enough for its narration so
    // clips never overlap. This MOVES the steps, so the new positions flow back
    // to the caller as stepTimes (not a mere offset).
    const clipDurSec = narratableSteps.map(
      (step) => clips.find((c) => c.step === step)?.durationSec ?? 0
    );
    const retimed = await retimeForNarration({
      ffmpeg: ffmpegPath,
      videoPath,
      steps: narratableSteps,
      clipDurSec,
      temps,
    });
    if (!retimed) {
      return notApplied("could not probe the video to re-time it");
    }

    // 6. Title card (drawtext) — only if this build supports it. When present it
    // shifts the whole timeline by TITLE_SEC; otherwise the offset is 0.
    const titleOffsetSec = hasDrawtext ? TITLE_SEC : 0;
    let body = retimed.path;
    if (hasDrawtext) {
      body = await prependTitleCard({
        ffmpeg: ffmpegPath,
        videoPath: retimed.path,
        title: narration.title,
        temps,
      });
    } else {
      const note = "title card skipped — this ffmpeg has no `drawtext` filter";
      notes.push(note);
      log.warn({ ffmpeg: ffmpegPath }, `cinematic: ${note}`);
    }

    // Each step's final position and each clip's start, both shifted past the
    // title card. A clip starts exactly when its step's (re-timed) footage begins.
    const stepTimes = retimed.starts.map((s) => s + titleOffsetSec);
    const clipOffsetsSec = clips.map((clip) => {
      const idx = narratableSteps.indexOf(clip.step);
      return (idx >= 0 ? (retimed.starts[idx] ?? 0) : 0) + titleOffsetSec;
    });

    // 7 (write SRT unconditionally). Cues carry NARRATION text; each starts when
    // its clip plays and ends after the clip's audio duration.
    const srtPath = srtPathFor(videoPath);
    const cues = clips.map((clip, k) => {
      const start = clipOffsetsSec[k] ?? 0;
      return { start, end: start + clip.durationSec, text: clip.narration };
    });
    await writeFile(srtPath, buildSrt(cues));

    // Burn captions only when asked AND supported; otherwise the .srt sidecar is
    // the caption track (soft subs).
    const burnCaptions = options.captions && hasSubtitles;
    if (options.captions && !hasSubtitles) {
      const note =
        "captions not burned — this ffmpeg has no `subtitles` filter; wrote a soft-sub .srt instead";
      notes.push(note);
      log.warn({ ffmpeg: ffmpegPath }, `cinematic: ${note}`);
    }

    // 8. Mix narration onto the (re-timed, possibly title-prefixed) video; burn
    // captions if supported.
    const finalPath = `${videoPath}.cinematic.webm`;
    temps.push(finalPath);
    await mixAudioAndCaptions({
      ffmpeg: ffmpegPath,
      videoPath: body,
      clips,
      offsetsSec: clipOffsetsSec,
      srtPath,
      burnCaptions,
      outPath: finalPath,
    });

    const produced = await stat(finalPath);
    if (produced.size === 0) {
      return notApplied("encoder produced an empty file");
    }

    // 9. Atomic in-place replace (like condense).
    await rename(finalPath, videoPath);
    // The final file is now the original path — drop it from the cleanup list.
    temps.splice(temps.indexOf(finalPath), 1);
    return { applied: true, titleOffsetSec, stepTimes, notes };
  } catch (err) {
    log.debug(
      { err, videoPath },
      "cinematic processing failed; keeping original"
    );
    return notApplied(err instanceof Error ? err.message : String(err));
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }
}
