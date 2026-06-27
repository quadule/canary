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
  type MediaProviders,
  type MusicProvider,
  resolveMediaProviders,
  type TitleBackgroundProvider,
  type TtsProvider,
} from "./providers.js";
import { resolveOmlxProviders } from "./omlx.js";
import { formatCommand, shellQuote } from "./shell.js";
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

// A parsed `say -v '?'` entry. `full` is the exact string to pass to `say -v`,
// INCLUDING any "(Premium)"/"(Enhanced)" suffix — passing the bare name selects
// the low-quality compact variant even when a premium one is installed, which is
// why local narration used to sound robotic. `quality` lets us prefer the
// higher-fidelity downloads; `locale` lets us prefer US English.
interface InstalledVoice {
  full: string;
  locale: string;
  name: string;
  quality: "Premium" | "Enhanced" | "Default";
}

// Last-resort voice that ships on every Mac, used only when no installed voice
// can be parsed. One voice is picked per session (consistency) — an explicit
// premium/enhanced English voice when available, else $CANARY_SAY_VOICE.
const FALLBACK_VOICE = "Samantha";

// Burned-caption layout. The on-screen caption holds at most two lines; each is
// kept short enough (~48 chars) that, at the libass FontSize below, a line fits
// the frame width without libass re-wrapping it onto a third line. Narration
// longer than two lines is truncated with an ellipsis in the caption (the audio
// still speaks it in full); the prompt asks for short lines so that's rare.
const CAPTION_LINE_MAX = 48;
const CAPTION_MAX_LINES = 2;

// `say` speaking rate (words per minute). Default tuned for intelligibility;
// overridable via $CANARY_SAY_RATE.
const DEFAULT_SAY_RATE = 175;

// macOS ffmpeg is usually built without fontconfig, so drawtext needs an
// explicit font file rather than a font name.
const TITLE_FONT_FILE = "/System/Library/Fonts/Helvetica.ttc";

// Default font candidates, in order, across platforms — so the title card works
// on a Linux CI runner (with fonts-dejavu/liberation installed), not just macOS.
const DEFAULT_FONTS = [
  TITLE_FONT_FILE,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

// First existing font among the preferred one then the cross-platform defaults,
// or undefined when nothing is installed (caller then skips the styled text).
function resolveFont(preferred?: string): string | undefined {
  const candidates = preferred ? [preferred, ...DEFAULT_FONTS] : DEFAULT_FONTS;
  return candidates.find((f) => existsSync(f));
}

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

// Resolve the title-card font+color for a category. The font is the category's
// preferred face if installed, else the first available cross-platform default,
// else undefined (no usable font on this host → the caller skips the title card).
export function titleStyle(category: ThemeCategory | undefined): {
  font: string | undefined;
  color: string;
} {
  const pref = (category && TITLE_STYLES[category]) || DEFAULT_TITLE_STYLE;
  return { font: resolveFont(pref.font), color: pref.color };
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
  cues: { start: number; end: number; text: string }[],
  maxCharsPerLine = CAPTION_LINE_MAX
): string {
  return cues
    .map((cue, i) => {
      const start = secToSrtTimestamp(cue.start);
      const end = secToSrtTimestamp(cue.end);
      const text = wrapCaption(cue.text, maxCharsPerLine);
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join("\n");
}

// Caption chars-per-line scaled to the video width. The libass caption font
// doesn't shrink as fast as the frame, so a fixed budget that fits the 1280px
// default viewport overflows a narrow one. Calibrated against burned frames:
// 48 chars = two lines at 1280px, and a narrower frame needs proportionally
// fewer (~30 at 800px). Capped at CAPTION_LINE_MAX so a very wide video still
// keeps captions to a readable ~two short lines, and floored so a tiny viewport
// doesn't truncate to nothing.
export function captionLineMax(width: number | undefined): number {
  if (!width || width <= 0) {
    return CAPTION_LINE_MAX;
  }
  return Math.max(24, Math.min(CAPTION_LINE_MAX, Math.floor(width * 0.0375)));
}

function truncateWithEllipsis(line: string, limit: number): string {
  if (line.length + 1 <= limit) {
    return `${line}…`;
  }
  return `${line.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// Wrap caption text for burn-in so it never shows more than `maxLines` lines.
// Greedy word wrap at `maxCharsPerLine`; if the text needs more lines than that,
// the last line is truncated with an ellipsis. The explicit line breaks become
// libass `\N`, and because each line stays well within the frame width libass's
// own (smart) wrapping won't add a surprise extra line on top.
export function wrapCaption(
  text: string,
  maxCharsPerLine = CAPTION_LINE_MAX,
  maxLines = CAPTION_MAX_LINES
): string {
  const limit = Math.max(1, maxCharsPerLine);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    // `word` won't fit on the current line. If a new line would exceed the
    // budget, stop here — the leftover words get folded into an ellipsis.
    if (lines.length + 1 >= maxLines) {
      truncated = true;
      break;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  if (truncated) {
    lines[lines.length - 1] = truncateWithEllipsis(lines.at(-1) ?? "", limit);
  }
  return lines.join("\n");
}

// One audio input to the mix: where it starts (ms) and an optional volume scale
// (narration plays at 1.0; a music bed sits low, e.g. 0.18).
export interface AudioTrack {
  delayMs: number;
  volume?: number;
}

// Build the ffmpeg `filter_complex` that delays each audio input to its place on
// the timeline (and scales its volume) and mixes them into one stereo track
// [aout]. Inputs are ffmpeg indices 1..N (input 0 is the video), in the SAME
// order as `tracks`. Returns "" for no tracks (caller then skips the mix).
export function buildAudioMix(tracks: AudioTrack[]): string {
  if (tracks.length === 0) {
    return "";
  }
  const chains = tracks
    .map((t, i) => {
      const vol =
        t.volume === undefined ? "" : `,volume=${t.volume.toFixed(3)}`;
      return `[${i + 1}:a]adelay=${t.delayMs}|${t.delayMs}${vol}[a${i}]`;
    })
    .join(";");
  const labels = tracks.map((_, i) => `[a${i}]`).join("");
  // normalize=0 keeps each track at its set level; dropout_transition=0 stops
  // amix from ducking when a track ends (so the bed doesn't swell between lines).
  return `${chains};${labels}amix=inputs=${tracks.length}:normalize=0:dropout_transition=0[aout]`;
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
// Pull the text out of any page.showCaption("…") calls in a step's script.
// In a cinematic recording these overlays aren't drawn (the burned captions
// replace them), but the operator's own caption is the clearest statement of
// what the step is about — so it's fed to the narration LLM as intent context,
// in full (captions are short) rather than risking the truncated script slice.
// Handles single, double, and template-literal quotes and basic escapes.
export function extractCaptions(script: string | undefined): string[] {
  if (!script) {
    return [];
  }
  const captions: string[] = [];
  const re = /showCaption\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null = re.exec(script);
  while (match !== null) {
    const text = (match[2] ?? "").replace(/\\(["'`\\])/g, "$1").trim();
    if (text) {
      captions.push(text);
    }
    match = re.exec(script);
  }
  return captions;
}

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
      const captions = extractCaptions(step.script);
      const intentPart = captions.length
        ? ` — intent: ${captions.map((c) => `"${c}"`).join(" ")}`
        : "";
      return `  ${step.index}. ${step.name}${scriptPart}${intentPart}`;
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
    "- Write one narration entry per step: SHORT and PUNCHY — ideally ONE sentence, never more than two, and at most ~18 words / ~95 characters so it fits two on-screen caption lines and reads aloud within the step's brief window. A longer line is truncated on screen. Favor brevity over flourish.",
    "- Stay in character for the creative direction throughout; commit to the bit.",
    "- Never repeat the literal step name; describe what is happening in that voice.",
    '- A step may carry an "intent:" note — the operator\'s own caption for that moment, the clearest signal of WHY it matters. Let it guide your narration, but rewrite it fully in character; never quote it verbatim.',
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

// Parse `say -v '?'` output into structured voices. Each line is
// "<Name>[ (Quality)]   <locale>   # sample" — columns separated by runs of
// spaces. macOS lists only the highest-quality installed build of each voice
// but keeps a hidden compact build reachable by identifier (verified:
// `say -v com.apple.voice.compact.en-US.Ava` succeeds with audible-quality
// audio distinct from "Ava (Premium)"). Passing the full listed token,
// INCLUDING its "(Premium)"/"(Enhanced)" suffix, pins the listed (high-quality)
// variant; we keep the quality tag and locale so the picker can prefer the
// premium/enhanced US-English downloads over a plain compact voice.
export function parseInstalledVoices(stdout: string): InstalledVoice[] {
  const voices: InstalledVoice[] = [];
  for (const line of stdout.split("\n")) {
    // Name column ends at the first run of 2+ spaces, before the BCP-47-ish
    // locale (en_US / en-US / en_GB). Intra-name spaces are single, so a
    // multi-word voice name ("Bad News") stays intact.
    const match = line.match(/^(.+?)\s{2,}([A-Za-z]{2}[-_][A-Za-z]{2})\b/);
    if (!(match?.[1] && match[2])) {
      continue;
    }
    const full = match[1].trim();
    if (!full) {
      continue;
    }
    // The capture group is exactly "Premium" or "Enhanced" when present.
    const qualityMatch = /\((Premium|Enhanced)\)\s*$/.exec(full);
    const quality: InstalledVoice["quality"] = qualityMatch
      ? (qualityMatch[1] as "Premium" | "Enhanced")
      : "Default";
    const name = full.replace(/\s*\((?:Premium|Enhanced)\)\s*$/, "").trim();
    voices.push({ full, name, quality, locale: match[2].replace("-", "_") });
  }
  return voices;
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

// A user-facing line emitter (routed to onProgress → stderr). Optional so probes
// stay silent; generation sites pass one so the exact command is shown.
type Echo = (line: string) => void;

// Run a command and return its stdout/stderr. Bumped maxBuffer and a hard
// timeout, like condense's runFfmpeg. Throws on non-zero exit / timeout — every
// caller is inside cinematicProcess's try/catch. When `echo` is supplied the
// exact command is printed first (copy-paste reproduction); probes omit it so
// version checks (`say -v ?`, `ffmpeg -version`, `git …`) don't spam the output.
async function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  echo?: Echo
): Promise<{ stdout: string; stderr: string }> {
  echo?.(`$ ${formatCommand(cmd, args)}`);
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

// The command used to synthesize speech, `say` by default. Override with
// $CANARY_SAY_COMMAND to point at a say-compatible binary — a non-macOS TTS tool,
// or a wrapper that authorizes a macOS Personal Voice (e.g. a one-line script:
// `exec env DYLD_INSERT_LIBRARIES=…/mysay.dylib say "$@"`; see SavePersonalVoiceAudio).
// It's invoked with the same argv `say` gets: `-v <voice> -r <rate> <text> -o <out>`.
export function sayCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.CANARY_SAY_COMMAND?.trim() || "say";
}

// List the voices the say command can use, or null if it's missing/unusable or
// doesn't support the `-v ?` listing (a custom non-macOS command may not). Used
// as the precondition probe and to constrain the voice pick to installed voices.
async function listSayVoices(
  command: string
): Promise<InstalledVoice[] | null> {
  try {
    const { stdout } = await run(command, ["-v", "?"], VERSION_PROBE_TIMEOUT_MS);
    return parseInstalledVoices(stdout);
  } catch {
    return null;
  }
}

// Pick the session voice and return the exact `-v` string. An explicit
// $CANARY_SAY_VOICE always wins (the user asked for it; let `say` error loudly
// if it's wrong). Otherwise prefer the highest-fidelity US-English download
// actually installed — Premium over Enhanced, US English over other English,
// English over anything — because a bare/compact voice (e.g. the default
// Samantha) is what made earlier narration sound robotic. Falls back to
// "Samantha" so a fresh Mac without premium downloads still narrates.
export function pickVoice(voices: InstalledVoice[]): string {
  const override = process.env.CANARY_SAY_VOICE;
  if (override) {
    return override;
  }
  const isEnglish = (v: InstalledVoice) => /^en[-_]/i.test(v.locale);
  const isUsEnglish = (v: InstalledVoice) => /^en[-_]us$/i.test(v.locale);
  const premium = voices.filter((v) => v.quality === "Premium");
  const enhanced = voices.filter((v) => v.quality === "Enhanced");
  // Tiers from most to least preferred; first non-empty tier wins.
  const tiers: InstalledVoice[][] = [
    premium.filter(isUsEnglish),
    premium.filter(isEnglish),
    premium,
    enhanced.filter(isUsEnglish),
    enhanced.filter(isEnglish),
    enhanced,
    voices.filter((v) => isEnglish(v) && v.name === FALLBACK_VOICE),
    voices.filter(isEnglish),
  ];
  for (const tier of tiers) {
    if (tier.length > 0) {
      const pick = tier[Math.floor(Math.random() * tier.length)];
      if (pick) {
        return pick.full;
      }
    }
  }
  return FALLBACK_VOICE;
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
  log: Logger,
  echo?: Echo
): Promise<Narration | null> {
  let stdout: string;
  try {
    ({ stdout } = await run("claude", ["-p", prompt], LLM_TIMEOUT_MS, echo));
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
  echo?: Echo;
}): Promise<{
  direction: ReturnType<typeof resolveDirection>;
  narration: Narration;
  repoDir: string;
  base: string;
} | null> {
  const { options, narratableSteps, log, echo } = args;
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
  const narration = await generateNarration(prompt, log, echo);
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

// Generate a themed title-card background image, or undefined if unavailable.
// Best-effort: a provider failure falls back to the solid-color card + a note.
async function renderTitleBackground(args: {
  provider: TitleBackgroundProvider | undefined;
  directionText: string;
  geometry: ProbedVideo;
  videoPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<string | undefined> {
  const { provider, directionText, geometry, videoPath, temps, notes, log } =
    args;
  if (!provider) {
    return;
  }
  args.progress("generating a title background…");
  const bgPath = `${videoPath}.titlebg.png`;
  temps.push(bgPath);
  try {
    await provider.render(
      directionText,
      geometry.width,
      geometry.height,
      bgPath
    );
    return bgPath;
  } catch (err) {
    log.debug({ err }, "cinematic: title background failed; using solid card");
    notes.push("title background unavailable — used a solid card");
    return;
  }
}

// Generate music tracks for the mix: a low instrumental bed under the whole
// video, and a fuller song over the credits region. Best-effort per track; a
// failure (e.g. Lyria unavailable on this API) just drops that track + notes it.
async function generateMusic(args: {
  ffmpeg: string;
  provider: MusicProvider | undefined;
  directionText: string;
  bodyPath: string;
  finalBodyPath: string;
  videoPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
  progress: (message: string) => void;
}): Promise<MusicTrack[]> {
  const {
    ffmpeg,
    provider,
    directionText,
    bodyPath,
    finalBodyPath,
    videoPath,
    temps,
    notes,
    log,
  } = args;
  if (!provider) {
    return [];
  }
  const total = await audioDurationSec(ffmpeg, finalBodyPath);
  if (!total) {
    return [];
  }
  args.progress("composing the score…");
  const tracks: MusicTrack[] = [];
  try {
    const bedPath = `${videoPath}.bed.wav`;
    temps.push(bedPath);
    await provider.bed(directionText, total, bedPath);
    tracks.push({ path: bedPath, delaySec: 0, volume: 0.16 });
  } catch (err) {
    log.debug({ err }, "cinematic: instrumental bed unavailable");
    notes.push("instrumental score unavailable");
  }
  const creditsStart = await audioDurationSec(ffmpeg, bodyPath);
  if (creditsStart && total - creditsStart > 1) {
    try {
      const songPath = `${videoPath}.song.wav`;
      temps.push(songPath);
      await provider.song(directionText, total - creditsStart, songPath);
      tracks.push({ path: songPath, delaySec: creditsStart, volume: 0.5 });
    } catch (err) {
      log.debug({ err }, "cinematic: credits song unavailable");
      notes.push("credits song unavailable");
    }
  }
  return tracks;
}

// Turn the condensed body + narration clips into the final cinematic video:
// re-time so each step holds for its line, prepend the title card (optionally
// over a generated background), append the credits, and generate any music.
// Returns the final body, where each step/clip lands, and the music tracks — or
// null if the source duration can't be probed for re-timing.
async function assembleVideo(args: {
  ffmpeg: string;
  videoPath: string;
  narratableSteps: CinematicStep[];
  clips: RenderedClip[];
  title: string;
  category: ThemeCategory | undefined;
  directionText: string;
  providers: MediaProviders;
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
  music: MusicTrack[];
} | null> {
  const {
    ffmpeg,
    videoPath,
    narratableSteps,
    clips,
    title,
    category,
    directionText,
    providers,
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

  const background =
    hasDrawtext && geometry
      ? await renderTitleBackground({
          provider: providers.titleBackground,
          directionText,
          geometry,
          videoPath,
          temps,
          notes,
          log,
          progress,
        })
      : undefined;

  progress("painting the title card…");
  const { body, titleOffsetSec } = await applyTitleCard({
    ffmpeg,
    retimedPath: retimed.path,
    title,
    style: titleStyle(category),
    background,
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

  const music = await generateMusic({
    ffmpeg,
    provider: providers.music,
    directionText,
    bodyPath: body,
    finalBodyPath: finalBody,
    videoPath,
    temps,
    notes,
    log,
    progress,
  });

  return { finalBody, stepTimes, clipOffsetsSec, titleOffsetSec, music };
}

interface RenderedClip {
  durationSec: number;
  m4aPath: string;
  narration: string;
  step: CinematicStep;
}

// A generated music input for the final mix: an audio file, when it starts, and
// its (low) gain under the narration.
interface MusicTrack {
  delaySec: number;
  path: string;
  volume: number;
}

// How to turn narration text into a raw audio file: `ext` is that file's
// extension, `run` writes it. A say-backed synth writes .aiff; a TTS provider
// writes .wav. renderClip is otherwise provider-agnostic.
interface SpeechSynth {
  ext: string;
  run: (text: string, outPath: string) => Promise<void>;
}

function saySynth(
  command: string,
  voice: string,
  rate: number,
  echo?: Echo
): SpeechSynth {
  return {
    ext: "aiff",
    run: (text, outPath) =>
      run(
        command,
        ["-v", voice, "-r", String(rate), text, "-o", outPath],
        SAY_TIMEOUT_MS,
        echo
      ).then(() => undefined),
  };
}

// Run a $CANARY_SAY_COMMAND override through the shell so the command STRING can
// carry its own arguments (flags, quoting, redirects). The text to speak is the
// only argument we append (passed as the positional "$@", never interpolated, so
// narration can't inject shell). The output path and the voice ride in the
// environment: $CANARY_SAY_OUTPUT is where the command must write the audio, and
// $CANARY_SAY_VOICE (if the user set it) is inherited for the command to read.
async function runSayCommand(
  command: string,
  text: string,
  outPath: string,
  echo?: Echo
): Promise<void> {
  echo?.(
    `$ CANARY_SAY_OUTPUT=${shellQuote(outPath)} ${command} ${shellQuote(text)}`
  );
  await execFileAsync("/bin/sh", ["-c", `${command} "$@"`, "sh", text], {
    timeout: SAY_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CANARY_SAY_OUTPUT: outPath },
  });
}

// Synth for a $CANARY_SAY_COMMAND override. The command may not be `say`, so we
// impose no say-specific flags — it gets the text (only) and writes to
// $CANARY_SAY_OUTPUT. Use it for a non-macOS TTS tool, or a wrapper that voices a
// macOS Personal Voice, e.g. (chmod +x, then point $CANARY_SAY_COMMAND at it):
//   exec env DYLD_INSERT_LIBRARIES=…/mysay.dylib \
//     say -v "$CANARY_SAY_VOICE" -o "$CANARY_SAY_OUTPUT" "$1"
export function customSaySynth(command: string, echo?: Echo): SpeechSynth {
  return {
    ext: "aiff",
    run: (text, outPath) => runSayCommand(command, text, outPath, echo),
  };
}

// Decide how narration gets voiced: a TTS provider when present, with the `say`
// command as the fallback. `say` is macOS-only, but $CANARY_SAY_COMMAND can point
// at a say-compatible binary (a non-macOS tool, or a Personal Voice shim), so the
// say path is also taken off-macOS when that's set. Returns the say synth (if
// usable here), the rate, and a reproducibility voice label — or null when
// there's NO way to voice it, so cinematic can run anywhere a key/command is set.
async function resolveSpeech(
  providers: MediaProviders,
  notes: string[],
  echo?: Echo
): Promise<{ say?: SpeechSynth; rate: number; label: string } | null> {
  const rate = pickRate();
  const command = sayCommand();
  const voiceOverride = process.env.CANARY_SAY_VOICE?.trim();
  let say: SpeechSynth | undefined;
  let sayLabel = "";
  if (command !== "say") {
    // Custom command: it owns voice/rate, so we only feed it text + output. Works
    // on any platform. $CANARY_SAY_VOICE is optional here (for the label only).
    say = customSaySynth(command, echo);
    sayLabel = voiceOverride ? `${command}:${voiceOverride}` : command;
  } else if (process.platform === "darwin") {
    const installed = await listSayVoices(command);
    // An explicit $CANARY_SAY_VOICE always wins and works even when listing
    // fails. Otherwise pick the best installed voice.
    const voice =
      voiceOverride || (installed ? pickVoice(installed) : undefined);
    if (voice) {
      say = saySynth(command, voice, rate, echo);
      // sayLabel is the full `-v` identifier (e.g. "Ava (Premium)"), surfaced in
      // meta so a good run can be reproduced via $CANARY_SAY_VOICE.
      sayLabel = voice;
      // The compact voices are the ones that sound robotic. macOS hides a
      // compact build behind every premium/enhanced voice, so a name like
      // "Ava (Premium)" DOES reach the premium asset — but if no premium or
      // enhanced English voice is installed at all, the pick falls through to a
      // compact voice. When that happens and no higher-quality TTS provider is
      // configured, say so, since it's the usual cause of robotic narration.
      const chosen = installed?.find((v) => v.full === voice);
      const fellBackToCompact = !chosen || chosen.quality === "Default";
      if (!(providers.tts || voiceOverride) && fellBackToCompact) {
        notes.push(
          "no premium/enhanced English voice installed — narration uses the compact (robotic-sounding) voice; download one in System Settings › Accessibility › Spoken Content › System Voice (e.g. Ava, Zoe), or set GEMINI_API_KEY for higher-quality TTS"
        );
      }
    }
  }
  if (!(providers.tts || say)) {
    return null;
  }
  return { say, rate, label: providers.tts?.label ?? sayLabel };
}

// Synthesize one narration clip with `synth`, transcode to AAC/m4a, and probe its
// duration (for caption end-times). Pushes its temps for cleanup. Returns null
// if the clip can't be produced. Throws if `synth.run` throws (caller may retry
// with a fallback synth).
async function renderClip(args: {
  ffmpeg: string;
  synth: SpeechSynth;
  step: CinematicStep;
  narration: string;
  videoPath: string;
  index: number;
  temps: string[];
  echo?: Echo;
}): Promise<RenderedClip | null> {
  const { ffmpeg, synth, step, narration, videoPath, index, temps, echo } =
    args;
  const rawPath = `${videoPath}.step${index}.${synth.ext}`;
  const m4aPath = `${videoPath}.step${index}.m4a`;
  temps.push(rawPath, m4aPath);

  await synth.run(narration, rawPath);
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      rawPath,
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "aac",
      m4aPath,
    ],
    ENCODE_TIMEOUT_MS,
    echo
  );
  const durationSec = await audioDurationSec(ffmpeg, m4aPath);
  if (durationSec === undefined || durationSec <= 0) {
    return null;
  }
  return { step, narration, m4aPath, durationSec };
}

// Synthesize a clip for every step that the LLM gave narration text. Prefers the
// TTS provider (when present); on its FIRST failure, notes it once and falls back
// to `say` for the rest (a consistent voice beats a half-provider mix). The step's
// enumerated index keys the narration map (same indexing the prompt used).
async function synthesizeClips(args: {
  ffmpeg: string;
  say?: SpeechSynth;
  tts?: TtsProvider;
  steps: CinematicStep[];
  byIndex: Map<number, string>;
  videoPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
  echo?: Echo;
}): Promise<RenderedClip[]> {
  const { ffmpeg, say, tts, steps, byIndex, videoPath, temps, notes, log, echo } =
    args;
  let provider: SpeechSynth | undefined = tts
    ? { ext: "wav", run: (t, o) => tts.synthesize(t, o) }
    : undefined;
  const clips: RenderedClip[] = [];
  for (const [i, step] of steps.entries()) {
    const text = byIndex.get(i)?.trim();
    if (!text) {
      continue;
    }
    const base = {
      ffmpeg,
      step,
      narration: text,
      videoPath,
      index: i,
      temps,
      echo,
    };
    let clip: RenderedClip | null = null;
    if (provider) {
      try {
        clip = await renderClip({ ...base, synth: provider });
      } catch (err) {
        log.debug({ err }, "cinematic: TTS provider failed; using `say`");
        notes.push(
          `narration voiced by macOS \`say\` — the TTS provider (${tts?.id}) failed`
        );
        provider = undefined;
      }
    }
    if (clip === null && provider === undefined && say) {
      clip = await renderClip({ ...base, synth: say });
    }
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

  const drawtext = [
    `fontfile=${style.font}`,
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
  style: { font: string | undefined; color: string };
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
  if (hasDrawtext && geometry && style.font) {
    const body = await prependTitleCard({
      ffmpeg,
      videoPath: retimedPath,
      title,
      style: { font: style.font, color: style.color },
      background,
      geometry,
      temps,
    });
    return { body, titleOffsetSec: TITLE_SEC };
  }
  let note = "title card skipped — this ffmpeg has no `drawtext` filter";
  if (hasDrawtext && !geometry) {
    note =
      "title card skipped — couldn't probe the video geometry (no ffprobe?)";
  } else if (hasDrawtext && !style.font) {
    note = "title card skipped — no usable font installed";
  }
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
  music: MusicTrack[];
  srtPath: string;
  burnCaptions: boolean;
  outPath: string;
  echo?: Echo;
}): Promise<void> {
  const {
    ffmpeg,
    videoPath,
    clips,
    offsetsSec,
    music,
    srtPath,
    burnCaptions,
    outPath,
    echo,
  } = args;
  // Audio inputs (and their mix tracks) in lockstep: narration clips at full
  // volume first, then any music underneath at its set gain.
  const tracks: AudioTrack[] = [
    ...offsetsSec.map((s) => ({ delayMs: Math.round(s * 1000) })),
    ...music.map((m) => ({
      delayMs: Math.round(m.delaySec * 1000),
      volume: m.volume,
    })),
  ];
  const filter = buildAudioMix(tracks);

  const inputs = ["-i", videoPath];
  for (const clip of clips) {
    inputs.push("-i", clip.m4aPath);
  }
  for (const track of music) {
    inputs.push("-i", track.path);
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
    ENCODE_TIMEOUT_MS,
    echo
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
    // Echo each generation command (say/ffmpeg/claude, and a redacted curl for
    // HTTP providers) so a run is easy to reproduce and tweak — the user can copy
    // a line, change the voice/model, and re-run it by hand. `progress` already
    // matches the Echo shape, so commands ride the same stderr channel.
    const echo: Echo = progress;

    // Media providers, preferred local-first: oMLX (on-machine MLX models) wins
    // per capability, then Gemini (if a key is set), then the local say/drawtext
    // fallbacks. Each is best-effort — a failure degrades to the next. oMLX is
    // probed (it lists its loaded models) only when it's configured.
    const omlx = await resolveOmlxProviders({ env: process.env, log, echo });
    const gemini = resolveMediaProviders({ env: process.env, log });
    const providers: MediaProviders = {
      tts: omlx.tts ?? gemini.tts,
      music: omlx.music ?? gemini.music,
      titleBackground: gemini.titleBackground,
      notes: [],
    };
    notes.push(...omlx.notes);
    // Only surface Gemini's notes when Gemini is actually active, or when oMLX
    // didn't cover TTS — otherwise its "no key → using say" note contradicts the
    // oMLX-narration note above.
    if (gemini.tts || !omlx.tts) {
      notes.push(...gemini.notes);
    }

    // Voicing: a TTS provider, or macOS `say`. With a provider this runs on any
    // platform; without one it needs macOS.
    const speech = await resolveSpeech(providers, notes, echo);
    if (!speech) {
      return notApplied(
        "cinematic narration needs macOS `say` or a TTS provider (set GEMINI_API_KEY)"
      );
    }

    // 2 + 3. Resolve the creative direction (+ change scale) and get narration.
    progress("writing narration…");
    const planned = await planNarration({
      options,
      narratableSteps,
      log,
      echo,
    });
    if (!planned) {
      return notApplied("narration generation failed");
    }
    const { direction, narration, repoDir, base } = planned;

    // 4. Voice + TTS: one clip per step that got narration text. The provider
    // voices it when available (else macOS `say`). Surface the chosen
    // direction/voice/rate so a delightful run can be reproduced (pin via
    // --prompt and $CANARY_SAY_VOICE / $CANARY_SAY_RATE).
    const meta: CinematicMeta = {
      direction: direction.label,
      voice: speech.label,
      rate: speech.rate,
    };
    log.info(meta, "cinematic: narration parameters");
    progress(`voicing ${narration.steps.length} lines (${meta.voice})…`);
    const clips = await synthesizeClips({
      ffmpeg: ffmpegPath,
      say: speech.say,
      tts: providers.tts,
      steps: narratableSteps,
      byIndex: new Map(narration.steps.map((s) => [s.index, s.narration])),
      videoPath,
      temps,
      notes,
      log,
      echo,
    });
    if (clips.length === 0) {
      return notApplied("no narration audio could be synthesized");
    }

    // 5–6. Re-time the video, prepend the title card (optionally over a generated
    // background), append the credits, and generate any music bed — producing the
    // final body, each step's/clip's position, and the music tracks for the mix.
    const assembled = await assembleVideo({
      ffmpeg: ffmpegPath,
      videoPath,
      narratableSteps,
      clips,
      title: narration.title,
      category: direction.category,
      directionText: direction.text,
      providers,
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
    const { finalBody, stepTimes, clipOffsetsSec, titleOffsetSec, music } =
      assembled;

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
    // Size each caption line to the actual video width so it holds to two lines
    // on a narrow custom --viewport, not just the 1280px default.
    const srtGeometry = await probeVideo(ffmpegPath, videoPath);
    await writeFile(
      srtPath,
      buildSrt(cues, captionLineMax(srtGeometry?.width))
    );

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
      music,
      srtPath,
      burnCaptions,
      outPath: finalPath,
      echo,
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
