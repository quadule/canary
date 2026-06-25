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
import { existsSync } from "node:fs";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@usecanary/logger";
import { branchContributors, buildCreditsRoll } from "./credits.js";
import {
  type StyleId,
  selectStyle,
  selectThemes,
  type ThemeCategory,
} from "./themes.js";

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

// A small, curated title-card look per theme category: a font that fits the genre
// and a high-contrast color (always rendered over a dark scrim, so brights read).
// Not a font-discovery engine — just enough to make the card feel intentional.
// Unknown/missing fonts fall back to Helvetica/white via titleStyle().
const TITLE_STYLES: Record<ThemeCategory, { font: string; color: string }> = {
  movie: { font: "/System/Library/Fonts/Times.ttc", color: "white" },
  tv: { font: "/System/Library/Fonts/Supplemental/Futura.ttc", color: "white" },
  documentary: {
    font: "/System/Library/Fonts/Helvetica.ttc",
    color: "0xF5F5F0",
  },
  commercial: {
    font: "/System/Library/Fonts/Supplemental/Impact.ttf",
    color: "0xFFD400",
  },
  training: { font: "/System/Library/Fonts/Helvetica.ttc", color: "0x7FE0FF" },
  radio: {
    font: "/System/Library/Fonts/Supplemental/Courier New.ttf",
    color: "0xFFB347",
  },
  sports: {
    font: "/System/Library/Fonts/Supplemental/Impact.ttf",
    color: "white",
  },
  game_show: {
    font: "/System/Library/Fonts/Supplemental/Impact.ttf",
    color: "0xFFD400",
  },
  soap: {
    font: "/System/Library/Fonts/Supplemental/Georgia.ttf",
    color: "0xFFE9F0",
  },
  news: { font: "/System/Library/Fonts/Helvetica.ttc", color: "white" },
  kids: { font: "/System/Library/Fonts/SFNSRounded.ttf", color: "0xFF7AD9" },
};

const DEFAULT_TITLE_STYLE = { font: TITLE_FONT_FILE, color: "white" };

// Resolve the title-card font+color for a category, falling back to
// Helvetica/white when the category is unknown or its font isn't installed.
export function titleStyle(category: ThemeCategory | undefined): {
  font: string;
  color: string;
} {
  const pref = (category && TITLE_STYLES[category]) || DEFAULT_TITLE_STYLE;
  const font = existsSync(pref.font) ? pref.font : TITLE_FONT_FILE;
  return { font, color: pref.color };
}

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
  // Called as each stage starts so the caller can show the user live progress
  // (this pass takes a while — LLM call, TTS, several encodes).
  onProgress?: (message: string) => void;
  // Verbatim user steer (--prompt) for theme/tone/style; when set, the random
  // theme + style draw is skipped and this drives the narration.
  prompt?: string;
  // Directory of the project under review — its branch (vs configured base) sets
  // the contributor credits and scales the narration. Defaults to process.cwd().
  repoDir?: string;
}

export interface CinematicMeta {
  // Human-readable creative direction (the random theme+style, or the --prompt),
  // surfaced so a good run can be reproduced.
  direction: string;
  rate: number;
  voice: string;
}

export interface CinematicResult {
  applied: boolean;
  // The chosen creative direction + voice/rate, surfaced so a good run can be
  // reproduced. Present only when applied.
  meta?: CinematicMeta;
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

// Wrap a title into lines of at most `maxChars`, honoring any explicit newlines
// the model included (so it can force a layout) and greedily word-wrapping the
// rest. A single word longer than the limit is kept whole rather than split.
// Pure → unit-tested.
export function wrapTitle(title: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const lines: string[] = [];
  for (const rawLine of title.split("\n")) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= limit) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") {
      lines.push(current);
    }
  }
  return lines.length > 0 ? lines : [""];
}

// Build the `claude -p` prompt: the creative direction, the step list, and a
// strict-JSON output contract. The `direction` is the already-composed steering
// text (a random theme+style draw, or the user's verbatim --prompt). Deterministic
// given its inputs (testable).
export function buildNarrationPrompt(args: {
  direction: string;
  change?: ChangeContext;
  steps: { index: number; name: string; script?: string }[];
}): string {
  const { direction, change, steps } = args;
  const stepLines = steps
    .map((step) => {
      const slice = step.script?.slice(0, SCRIPT_SLICE_CHARS).trim();
      const scriptPart = slice ? ` — does: ${slice}` : "";
      return `  ${step.index}. ${step.name}${scriptPart}`;
    })
    .join("\n");

  const changeLines = change
    ? [
        `Sense of scale (SECONDARY to the creative direction — use it only to size the length and energy, never to override the theme or its format): the change under review is ${change.label}, so ${change.scaleHint}.`,
        "",
      ]
    : [];

  return [
    "You are scripting voiceover narration for a screen-recording of an automated browser QA session.",
    "Narrate it as a short cinematic piece, fully in character for the creative direction below.",
    "",
    `Creative direction: ${direction}`,
    "",
    ...changeLines,
    "Steps (each is one moment in the video, in order):",
    stepLines,
    "",
    "Rules:",
    "- Write one narration entry per step: SHORT and PUNCHY, 1-2 sentences max, tight enough to be read aloud within the step's brief on-screen window. Favor brevity over flourish.",
    "- Stay in character for the creative direction throughout; commit to the bit.",
    "- Never repeat the literal step name; describe what is happening in that voice.",
    "- If the direction calls for a verse form (poem/limerick/haiku/song), write the narration in that form.",
    '- Provide a punchy, dramatic, mostly-uppercase "title" for an opening title card. You may use a newline in the title to force a two-line layout.',
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
  const parsed = tryParseJson(raw);
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
    steps.push({
      index: stepRecord.index,
      // Strip `{...}` runs: burned into the SRT they'd be parsed by libass as
      // style-override tags (reposition/recolor/hide). The narration is prose,
      // never tags.
      narration: stripOverrideTags(stepRecord.narration),
    });
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

// Remove ASS/SSA override tags (and stray braces) so narration burned into the
// captions can't restyle/reposition/hide itself via libass.
function stripOverrideTags(text: string): string {
  return text.replace(/\{[^}]*\}/g, "").replace(/[{}]/g, "");
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

// Parse the model's reply leniently: try the fence-stripped text, then fall back
// to the first `{`…last `}` slice so a chatty preamble ("Here's the narration:")
// doesn't abort the whole pass. Returns the parsed value or null.
function tryParseJson(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to brace extraction
  }
  const open = stripped.indexOf("{");
  const close = stripped.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try {
      return JSON.parse(stripped.slice(open, close + 1));
    } catch {
      return null;
    }
  }
  return null;
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

// Resolve the creative direction: the user's verbatim --prompt wins; otherwise
// draw ONE or TWO random themes (per the request — a focused draw the LLM can
// commit to, then adapt to the change's scale) + a weighted style. Returns the
// text injected into the prompt, a short reproducibility label, and the dominant
// theme category (drives the title-card font/color).
function resolveDirection(userPrompt: string | undefined): {
  text: string;
  label: string;
  category?: ThemeCategory;
} {
  if (userPrompt?.trim()) {
    const text = userPrompt.trim();
    return { text, label: `prompt: "${text}"` };
  }
  const count = Math.random() < 0.5 ? 1 : 2;
  const drawn = selectThemes(count);
  const themes = drawn.map((theme) => theme.label);
  const style = selectStyle();
  const themePart =
    themes.length === 1
      ? themes[0]
      : `commit to "${themes[0]}" as the dominant voice, optionally borrowing a flourish from "${themes[1]}"`;
  const text = `${themePart}. Render it as ${STYLE_DIRECTIVES[style]}`;
  return {
    text,
    label: `theme: ${themes.join(" + ")} · style: ${style}`,
    category: drawn[0]?.category,
  };
}

interface ChangeContext {
  // Stats line for the prompt, e.g. "45 commits, 71 files, +7386/-402".
  label: string;
  // A nudge toward the right production scale for the LLM to match.
  scaleHint: string;
}

// The branch's review base — its configured upstream (what it'll merge back
// into), NOT a hardcoded "main". Falls back to origin's default branch, then
// "main". Used for both the change-scale cue and the contributor credits so they
// count only this branch's own commits.
async function resolveBase(repoDir: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        repoDir,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ],
      VERSION_PROBE_TIMEOUT_MS
    );
    const upstream = stdout.trim();
    if (upstream) {
      return upstream;
    }
  } catch {
    // no configured upstream — fall through
  }
  try {
    const { stdout } = await run(
      "git",
      ["-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      VERSION_PROBE_TIMEOUT_MS
    );
    const def = stdout.trim();
    if (def) {
      return def;
    }
  } catch {
    // no origin/HEAD — fall through
  }
  return "main";
}

// Describe the change under review (branch vs base) so the narration can scale
// its production to match — a sweeping feature film for a big branch, a 30-second
// trailer for a tiny prep change. Best-effort: returns null off a git repo / with
// no diff, and the narration simply omits the scale cue.
async function describeChange(
  repoDir: string,
  base: string
): Promise<ChangeContext | null> {
  try {
    const { stdout: countOut } = await run(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${base}..HEAD`],
      VERSION_PROBE_TIMEOUT_MS
    );
    const commits = Number(countOut.trim());
    const { stdout: statOut } = await run(
      "git",
      ["-C", repoDir, "diff", "--shortstat", `${base}...HEAD`],
      VERSION_PROBE_TIMEOUT_MS
    );
    const files = Number(statOut.match(/(\d+) files? changed/)?.[1] ?? 0);
    const ins = Number(statOut.match(/(\d+) insertions?/)?.[1] ?? 0);
    const del = Number(statOut.match(/(\d+) deletions?/)?.[1] ?? 0);
    if (!(Number.isFinite(commits) && commits > 0) && files === 0) {
      return null;
    }
    const churn = ins + del;
    const scaleHint = changeScaleHint(commits, churn);
    return {
      label: `${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}, +${ins}/-${del}`,
      scaleHint,
    };
  } catch {
    return null;
  }
}

// Map change size to a sense of LENGTH/ENERGY only — deliberately format-agnostic
// so it never fights the random theme (an "epic film" cue would clash with a game
// show or a cooking-show theme). The theme leads; this just sizes the piece.
// Pure → testable.
export function changeScaleHint(commits: number, churn: number): string {
  if (commits <= 1 && churn < 60) {
    return "very small — keep it short and punchy, a beat or two";
  }
  if (commits <= 3 && churn < 250) {
    return "small — short and snappy";
  }
  if (commits <= 10 && churn < 1000) {
    return "medium — room for a full little arc";
  }
  return "large — go expansive; give it weight and a few more beats";
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

// Resolve the creative direction (+ change-scale cue) and generate the narration.
// Returns the direction (for title styling + reproducibility) and the narration,
// or null if generation failed.
async function planNarration(args: {
  options: CinematicOptions;
  narratableSteps: CinematicStep[];
  log: Logger;
}): Promise<{
  direction: ReturnType<typeof resolveDirection>;
  narration: Narration;
  repoDir: string;
  base: string;
} | null> {
  const { options, narratableSteps, log } = args;
  const direction = resolveDirection(options.prompt);
  const repoDir = options.repoDir ?? process.cwd();
  const base = await resolveBase(repoDir);
  const change = (await describeChange(repoDir, base)) ?? undefined;
  const prompt = buildNarrationPrompt({
    direction: direction.text,
    change,
    steps: narratableSteps.map((step, index) => ({
      index,
      name: step.name,
      script: step.script,
    })),
  });
  const narration = await generateNarration(prompt, log);
  return narration ? { direction, narration, repoDir, base } : null;
}

// Append a scrolling end-credits roll (this branch's contributors) after the body.
// Best-effort: returns the body unchanged on no contributors or any failure.
// Credits sit at the very end, so they don't shift any step's videoTime.
async function appendCredits(args: {
  ffmpeg: string;
  body: string;
  videoPath: string;
  heading: string;
  repoDir: string;
  base: string;
  geometry: ProbedVideo;
  temps: string[];
  log: Logger;
}): Promise<string> {
  const {
    ffmpeg,
    body,
    videoPath,
    heading,
    repoDir,
    base,
    geometry,
    temps,
    log,
  } = args;
  try {
    const contributors = await branchContributors(repoDir, base);
    if (contributors.length === 0) {
      return body;
    }
    const creditsPath = `${videoPath}.credits.webm`;
    temps.push(creditsPath);
    await buildCreditsRoll({
      ffmpeg,
      contributors,
      heading,
      geometry,
      outPath: creditsPath,
    });
    const outPath = `${videoPath}.withcredits.webm`;
    const listPath = `${videoPath}.credits-list.txt`;
    temps.push(outPath, listPath);
    await concatSegments(ffmpeg, [body, creditsPath], outPath, listPath);
    return outPath;
  } catch (err) {
    log.debug({ err }, "cinematic: credits roll failed; skipping it");
    return body;
  }
}

// Turn the condensed body + narration clips into the final cinematic video:
// re-time so each step holds for its line, prepend the title card, append the
// credits. Returns the final body path and where each step/clip lands in it, or
// null if the source duration can't be probed for re-timing.
async function assembleVideo(args: {
  ffmpeg: string;
  videoPath: string;
  narratableSteps: CinematicStep[];
  clips: RenderedClip[];
  title: string;
  category: ThemeCategory | undefined;
  hasDrawtext: boolean;
  repoDir: string;
  base: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<{
  finalBody: string;
  stepTimes: number[];
  clipOffsetsSec: number[];
  titleOffsetSec: number;
} | null> {
  const {
    ffmpeg,
    videoPath,
    narratableSteps,
    clips,
    title,
    category,
    hasDrawtext,
    repoDir,
    base,
    temps,
    notes,
    log,
    progress,
  } = args;

  // Probe geometry once: frame rate drives CFR re-encoding (exact slice
  // durations); width/height let the title card match the body. A failed probe
  // (no ffprobe) keeps a default frame rate but MUST skip the title/credits —
  // guessing geometry corrupts the concat.
  const geometry = await probeVideo(ffmpeg, videoPath);
  const frameRate = geometry?.frameRate ?? 30;

  progress("re-timing the video to fit the narration…");
  const clipDurSec = narratableSteps.map(
    (step) => clips.find((c) => c.step === step)?.durationSec ?? 0
  );
  const retimed = await retimeForNarration({
    ffmpeg,
    videoPath,
    steps: narratableSteps,
    clipDurSec,
    frameRate,
    temps,
  });
  if (!retimed) {
    return null;
  }

  progress("painting the title card…");
  const { body, titleOffsetSec } = await applyTitleCard({
    ffmpeg,
    retimedPath: retimed.path,
    title,
    style: titleStyle(category),
    hasDrawtext,
    geometry,
    temps,
    notes,
    log,
  });

  const stepTimes = retimed.starts.map((s) => s + titleOffsetSec);
  const clipOffsetsSec = clips.map((clip) => {
    const idx = narratableSteps.indexOf(clip.step);
    return (idx >= 0 ? (retimed.starts[idx] ?? 0) : 0) + titleOffsetSec;
  });

  let finalBody = body;
  if (hasDrawtext && geometry) {
    progress("rolling the credits…");
    finalBody = await appendCredits({
      ffmpeg,
      body,
      videoPath,
      heading: title,
      repoDir,
      base,
      geometry,
      temps,
      log,
    });
  }

  return { finalBody, stepTimes, clipOffsetsSec, titleOffsetSec };
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

// Render a 2.5s title card matching the source geometry, encoded to webm
// (libvpx) so the concat demuxer can stream-copy it ahead of the body. The
// title is wrapped to fit the frame (honoring any model-supplied line breaks),
// drawn in the category's font/color over a dark scrim, on either a solid black
// base or a provided background image (scaled+cropped to fill, then darkened).
async function buildTitleCard(args: {
  ffmpeg: string;
  title: string;
  style: { font: string; color: string };
  geometry: ProbedVideo;
  background?: string;
  temps: string[];
  outPath: string;
}): Promise<void> {
  const { ffmpeg, title, style, geometry, background, temps, outPath } = args;
  // Size text to the frame, then word-wrap; shrink a touch when it spills past
  // ~3 lines so a long title still fits without overflowing the card.
  const baseSize = Math.max(24, Math.round(geometry.height / 12));
  const maxChars = Math.max(
    8,
    Math.floor((geometry.width * 0.82) / (baseSize * 0.52))
  );
  const lines = wrapTitle(title, maxChars);
  const fontSize = lines.length > 3 ? Math.round(baseSize * 0.8) : baseSize;
  const lineSpacing = Math.round(fontSize * 0.35);

  // drawtext reads the text from a file (expansion=none) so newlines and any
  // %, :, \ in the title render literally — no filtergraph-escaping minefield.
  const textFile = `${outPath}.txt`;
  temps.push(textFile);
  await writeFile(textFile, lines.join("\n"));

  const font = existsSync(style.font) ? style.font : TITLE_FONT_FILE;
  const drawtext = [
    `fontfile=${font}`,
    `textfile=${textFile}`,
    "expansion=none",
    `fontcolor=${style.color}`,
    `fontsize=${fontSize}`,
    "text_align=C",
    `line_spacing=${lineSpacing}`,
    "x=(w-text_w)/2",
    "y=(h-text_h)/2",
    // Dark scrim behind the text so it stays legible over any background image.
    "box=1",
    "boxcolor=black@0.45",
    `boxborderw=${Math.round(fontSize * 0.6)}`,
  ].join(":");

  // Base layer: a provided background image (scaled to fill + darkened so white
  // text reads), else a solid black frame.
  const filter = background
    ? `scale=${geometry.width}:${geometry.height}:force_original_aspect_ratio=increase,crop=${geometry.width}:${geometry.height},eq=brightness=-0.25,drawtext=${drawtext},fps=${geometry.frameRate},setpts=N/FRAME_RATE/TB`
    : `drawtext=${drawtext}`;
  const input = background
    ? ["-loop", "1", "-t", String(TITLE_SEC), "-i", background]
    : [
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${geometry.width}x${geometry.height}:r=${geometry.frameRate}:d=${TITLE_SEC}`,
      ];

  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      ...input,
      "-vf",
      filter,
      "-r",
      String(geometry.frameRate),
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
  frameRate: number;
  outPath: string;
}): Promise<void> {
  const { ffmpeg, src, startSec, durSec, holdSec, frameRate, outPath } = args;
  // Force constant frame rate the way condense.ts does (fps + setpts), so each
  // slice's actual duration matches `-t`/`tpad` exactly. Without this, libvpx
  // slices come up tens of ms short and the per-segment error ACCUMULATES across
  // the concat, drifting narration/captions off the picture on long sessions.
  const fps = frameRate > 0 ? frameRate : 30;
  const chain = [`fps=${fps}`];
  if (holdSec > 0) {
    chain.push(`tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}`);
  }
  chain.push("setpts=N/FRAME_RATE/TB");
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
      "-vf",
      chain.join(","),
      "-r",
      String(fps),
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
  frameRate: number;
  temps: string[];
}): Promise<{ path: string; starts: number[] } | null> {
  const { ffmpeg, videoPath, steps, clipDurSec, frameRate, temps } = args;
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
      frameRate,
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
      frameRate,
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
// cleanup. Only called when drawtext is available AND geometry is known — the
// title MUST match the body's exact geometry or the concat-copy silently locks
// the body into the title's resolution and corrupts the picture.
async function prependTitleCard(args: {
  ffmpeg: string;
  videoPath: string;
  title: string;
  style: { font: string; color: string };
  background?: string;
  geometry: ProbedVideo;
  temps: string[];
}): Promise<string> {
  const { ffmpeg, videoPath, title, style, background, geometry, temps } = args;
  const titlePath = `${videoPath}.title.webm`;
  temps.push(titlePath);
  await buildTitleCard({
    ffmpeg,
    title,
    style,
    background,
    geometry,
    temps,
    outPath: titlePath,
  });
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

// Decide whether to prepend the title card, returning the body path to mix onto
// and the timeline offset it introduced. Skips (and records a note) when drawtext
// is unavailable or geometry couldn't be probed — guessing geometry would corrupt
// the concat.
async function applyTitleCard(args: {
  ffmpeg: string;
  retimedPath: string;
  title: string;
  style: { font: string; color: string };
  background?: string;
  hasDrawtext: boolean;
  geometry: ProbedVideo | undefined;
  temps: string[];
  notes: string[];
  log: Logger;
}): Promise<{ body: string; titleOffsetSec: number }> {
  const {
    ffmpeg,
    retimedPath,
    title,
    style,
    background,
    hasDrawtext,
    geometry,
    temps,
    notes,
    log,
  } = args;
  if (hasDrawtext && geometry) {
    const body = await prependTitleCard({
      ffmpeg,
      videoPath: retimedPath,
      title,
      style,
      background,
      geometry,
      temps,
    });
    return { body, titleOffsetSec: TITLE_SEC };
  }
  const note = hasDrawtext
    ? "title card skipped — couldn't probe the video geometry (no ffprobe?)"
    : "title card skipped — this ffmpeg has no `drawtext` filter";
  notes.push(note);
  log.warn({ ffmpeg }, `cinematic: ${note}`);
  return { body: retimedPath, titleOffsetSec: 0 };
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
    ? `${filter};[0:v]subtitles='${escapeSubtitlesPath(srtPath)}':force_style='${SUBTITLE_STYLE}'[vout]`
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

// Escape the subtitles path for the filtergraph. The caller wraps it in single
// quotes, so filtergraph metacharacters (, ; [ ]) are already literal; we escape
// the quote and libass-significant backslash/colon for safety inside the quotes.
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
    const progress = options.onProgress ?? (() => undefined);

    // 2 + 3. Resolve the creative direction (+ change scale) and get narration.
    progress("writing narration…");
    const planned = await planNarration({
      options,
      narratableSteps,
      log,
    });
    if (!planned) {
      return notApplied("narration generation failed");
    }
    const { direction, narration, repoDir, base } = planned;

    // 4. Voice + TTS: one clip per step that got narration text. Surface the
    // chosen direction/voice/rate so a delightful run can be reproduced (pin via
    // --prompt and $CANARY_SAY_VOICE/$CANARY_SAY_RATE).
    const voice = pickVoice(installedVoices);
    const rate = pickRate();
    const meta: CinematicMeta = { direction: direction.label, voice, rate };
    log.info(meta, "cinematic: narration parameters");
    progress(`voicing ${narration.steps.length} lines (${voice})…`);
    const clips = await synthesizeClips({
      ffmpeg: ffmpegPath,
      voice,
      rate,
      steps: narratableSteps,
      byIndex: new Map(narration.steps.map((s) => [s.index, s.narration])),
      videoPath,
      temps,
    });
    if (clips.length === 0) {
      return notApplied("no narration audio could be synthesized");
    }

    // 5–6. Re-time the video, prepend the title card, and append the credits —
    // producing the final body plus each step's/clip's position in it.
    const assembled = await assembleVideo({
      ffmpeg: ffmpegPath,
      videoPath,
      narratableSteps,
      clips,
      title: narration.title,
      category: direction.category,
      hasDrawtext,
      repoDir,
      base,
      temps,
      notes,
      log,
      progress,
    });
    if (!assembled) {
      return notApplied("could not probe the video to re-time it");
    }
    const { finalBody, stepTimes, clipOffsetsSec, titleOffsetSec } = assembled;

    // 7. Write the SRT (needed on disk before the burn pass reads it). Track it
    // as a temp so a later failure cleans it up — a stale .srt with cinematic
    // timings beside an un-processed video would mis-caption every soft-sub
    // player. It's promoted to a deliverable only after the rename succeeds.
    const srtPath = srtPathFor(videoPath);
    temps.push(srtPath);
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
    progress(
      burnCaptions ? "mixing audio and burning captions…" : "mixing audio…"
    );
    const finalPath = `${videoPath}.cinematic.webm`;
    temps.push(finalPath);
    await mixAudioAndCaptions({
      ffmpeg: ffmpegPath,
      videoPath: finalBody,
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
    // The final video is now the original path, and the .srt beside it is a
    // deliverable — drop both from the cleanup list.
    temps.splice(temps.indexOf(finalPath), 1);
    temps.splice(temps.indexOf(srtPath), 1);
    return { applied: true, titleOffsetSec, stepTimes, notes, meta };
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
