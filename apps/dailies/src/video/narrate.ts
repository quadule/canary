// Cinematic post-processing for session videos (opt-in via `dailies session end
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
import { existsSync } from "node:fs";
import {
  access,
  copyFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Logger } from "dailies-logger";
import { resolveAceStepMusic } from "./acestep.js";
import { songStepOnsets } from "./align.js";
import { pickLoudestOffset, resolveArchiveMusic } from "./archive.js";
import {
  branchContributors,
  buildCreditSections,
  buildCreditsRoll,
  type CreditSection,
} from "./credits.js";
import {
  audioDurationSec,
  availableFilters,
  concatSegments,
  type Echo,
  ENCODE_TIMEOUT_MS,
  encodeSlice,
  FFMPEG_BASE_ARGS,
  isOnPath,
  type ProbedVideo,
  probeVideo,
  run,
  trimAudio,
} from "./ffmpeg.js";
import { createLocalTitleBackground } from "./local-background.js";
import { resolveLocalImage } from "./local-image.js";
import { resolveOmlxProviders } from "./omlx.js";
import {
  type MediaProviders,
  type MusicProvider,
  resolveMediaProviders,
  type TitleBackgroundProvider,
  type TtsProvider,
} from "./providers.js";
import {
  buildLyricsPrompt,
  buildNarrationPrompt,
  describeChange,
  LYRICS_SCHEMA,
  type Lyrics,
  NARRATION_SCHEMA,
  type Narration,
  parseLyricsJson,
  parseNarrationJson,
  resolveBase,
  resolveDirection,
  runClaudeJson,
} from "./script-llm.js";
import { selectSongCaptions } from "./song-captions.js";
import { resolveSpeech, type SpeechSynth, speechText } from "./speech.js";
import { buildSrt, captionLineMax } from "./srt.js";
import type { ThemeCategory } from "./themes.js";
import { transcribeSong } from "./transcribe.js";
import { resolveWikimediaImage } from "./wikimedia.js";

// Opening title-card length, prepended to the front of the video. Every
// narration/caption offset is shifted by this so the on-screen step still lines
// up with its audio. The caller adds it to each step's report timeline too.
export const TITLE_SEC = 2.5;

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

// Score gains: the single cinematic-mode song sits low under the spoken
// narration, then swells to (near-)full for the credits roll. The ramp is the
// cross-fade length in seconds between the two.
const NARRATION_MUSIC_GAIN = 0.16;
const CREDITS_MUSIC_GAIN = 0.6;
const MUSIC_SWELL_RAMP_SEC = 1.5;

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
  // Song mode: replace per-step spoken narration with ONE sung song (LLM-written
  // themed lyrics performed by a singing music model over the whole video). No TTS;
  // the video is re-timed so each step's footage lands while its lyric line is sung,
  // and captions (timed to the vocals) are burned in. Needs a lyrics-capable music
  // provider (ACE-Step or Gemini Lyria).
  song?: boolean;
}

export interface CinematicMeta {
  // Human-readable creative direction (the random theme+style, or the --prompt),
  // surfaced so a good run can be reproduced.
  direction: string;
  music?: string;
  // Narration mode: the speaking rate (wpm) and the chosen voice.
  rate: number;
  // Song mode: true, with `music` naming the model that sang the lyrics. (voice/
  // rate don't apply and are left empty/zero.)
  song?: boolean;
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

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested). No I/O, no subprocesses.
// ---------------------------------------------------------------------------

// How long to hold a step's frame for its sung lyric line (song-mode re-timing).
// ~2.5 words/sec singing plus a beat to read, floored so every line gets a
// readable hold and the body stays long enough to clear the song's intro, capped
// so one wordy line doesn't dominate. Pure → unit-tested.
export function songHoldSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(6.5, Math.max(3.5, words / 2.5 + 1));
}

// Minimum on-screen span a single sung lyric line should cover. Short QA steps
// otherwise get one frantic line each; grouping consecutive steps up to this
// span lets one verse breathe across 2+ steps.
const GROUP_MIN_SEC = 7;

// The longest a single sung lyric line may hold on screen — and the cap on how
// far one cue can extend the kept vocal region. ACE-Step loops/sustains its final
// line to fill a long generation; without this cap that one line's cue stretches
// across the whole tail (minutes), dragging both the caption and the trimmed body
// out into droning dead air. 8s comfortably covers any real sung line.
const MAX_CUE_SEC = 8;

// Each step's on-screen footage length in the condensed video, from the gaps
// between successive step positions (the last step has no following boundary, so
// fall back to its recorded duration). Pure → unit-tested.
export function stepFootageSec(
  steps: { videoTime: number; durationMs: number }[]
): number[] {
  return steps.map((s, i) => {
    const next = steps[i + 1];
    if (next) {
      return Math.max(0.1, next.videoTime - s.videoTime);
    }
    return Math.max(0.1, s.durationMs / 1000);
  });
}

// Group CONSECUTIVE steps so each group's footage totals at least `minSec` — so
// one sung lyric line can cover 2+ short steps instead of one line per step. A
// lone trailing step folds into the previous group (no stray one-step final
// verse); a multi-step remainder keeps its own line. Returns arrays of step
// indices, in order, partitioning every step exactly once. Pure → unit-tested.
export function groupStepsForLyrics(
  footageSec: number[],
  minSec: number
): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let acc = 0;
  for (let i = 0; i < footageSec.length; i++) {
    current.push(i);
    acc += footageSec[i] ?? 0;
    if (acc >= minSec) {
      groups.push(current);
      current = [];
      acc = 0;
    }
  }
  if (current.length > 0) {
    const last = groups.at(-1);
    // Fold a LONE trailing step into the previous group (no stray one-step final
    // verse); a multi-step remainder is substantial enough to keep its own line.
    if (last && current.length < 2) {
      last.push(...current);
    } else {
      groups.push(current);
    }
  }
  return groups;
}

// Collapse grouped steps into ONE lyric-prompt entry per group: the members'
// names joined, and their scripts concatenated so every member's captions/intent
// feed the single line. `index` is the GROUP ordinal — i.e. the lyric line index
// the model returns. Pure → unit-tested.
export function groupedLyricSteps(
  steps: { name: string; script?: string }[],
  groups: number[][]
): { index: number; name: string; script?: string }[] {
  return groups.map((members, g) => ({
    index: g,
    name: members
      .map((i) => steps[i]?.name ?? "")
      .filter(Boolean)
      .join(" → "),
    script: members
      .map((i) => steps[i]?.script)
      .filter((s): s is string => Boolean(s))
      .join("\n"),
  }));
}

// Lay out song-mode caption cues so they never overlap. Each lyric line wants to
// appear at its step's time, but condense can bunch several steps into the same
// instant (a static stretch trimmed to one point), which would stack captions on
// top of each other. This walks the lines in order and pushes each start to at
// least the previous cue's end, giving every line a readable minimum on screen;
// a line whose step has real spacing keeps its natural time (no-op for a flow
// whose steps are already spread out). The last line holds `tailSec`. Cues are
// clamped to end by `videoEndSec`. Pure → unit-tested.
export function layoutSongCues(
  items: { start: number; text: string }[],
  videoEndSec: number,
  opts: { minDurSec?: number; maxDurSec?: number; tailSec?: number } = {}
): { start: number; end: number; text: string }[] {
  const minDur = opts.minDurSec ?? 1.4;
  const maxDur = opts.maxDurSec ?? 5;
  const tail = opts.tailSec ?? 3;
  const cues: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const start = Math.max(item.start, cursor);
    if (videoEndSec > 0 && start >= videoEndSec) {
      break; // no room left on the timeline
    }
    const nextRaw = items[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    const isLast = i === items.length - 1;
    // Hold until the next line wants to start, bounded by [minDur, maxDur]; the
    // last line gets the tail hold.
    let end = isLast
      ? start + tail
      : Math.min(Math.max(nextRaw, start + minDur), start + maxDur);
    if (!isLast) {
      end = Math.max(end, start + minDur);
    }
    if (videoEndSec > 0) {
      end = Math.min(end, videoEndSec);
    }
    if (end <= start) {
      continue; // clamped to nothing at the very end of the video
    }
    cues.push({ start, end, text: item.text });
    cursor = end;
  }
  return cues;
}

// One audio input to the mix: where it starts (ms) and an optional volume scale
// (narration plays at 1.0; a music bed sits low, e.g. 0.18).
export interface AudioTrack {
  delayMs: number;
  // Optional linear fades on the GLOBAL timeline (seconds — the same clock as
  // delayMs, since adelay shifts the stream so its t matches video time). Used
  // to cross the single score track from its quiet narration level into the full
  // credits level without a second download or a volume-step pop.
  fadeInAtSec?: number;
  fadeInDurSec?: number;
  fadeOutAtSec?: number;
  fadeOutDurSec?: number;
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
      const fadeOut =
        t.fadeOutAtSec === undefined
          ? ""
          : `,afade=t=out:st=${t.fadeOutAtSec.toFixed(3)}:d=${(t.fadeOutDurSec ?? 1).toFixed(3)}`;
      const fadeIn =
        t.fadeInAtSec === undefined
          ? ""
          : `,afade=t=in:st=${t.fadeInAtSec.toFixed(3)}:d=${(t.fadeInDurSec ?? 1).toFixed(3)}`;
      return `[${i + 1}:a]adelay=${t.delayMs}|${t.delayMs}${vol}${fadeOut}${fadeIn}[a${i}]`;
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

// Resolve the creative direction (+ change-scale cue) and generate the narration.
// Returns the direction (for title styling + reproducibility) and the narration,
// or null if generation failed.
async function planNarration(args: {
  options: CinematicOptions;
  narratableSteps: CinematicStep[];
  log: Logger;
  echo?: Echo;
}): Promise<
  | {
      direction: ReturnType<typeof resolveDirection>;
      narration: Narration;
      repoDir: string;
      base: string;
    }
  | { error: string }
> {
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
  const result = await runClaudeJson({
    label: "narration",
    prompt,
    schema: NARRATION_SCHEMA,
    parse: parseNarrationJson,
    log,
    echo,
  });
  if ("error" in result) {
    return { error: result.error };
  }
  return { direction, narration: result.value, repoDir, base };
}

// Song-mode counterpart of planNarration: resolve the creative direction (theme
// as genre) and generate the lyrics. Returns the direction (for title styling +
// reproducibility) and the lyrics, or a reason generation failed.
async function planSong(args: {
  options: CinematicOptions;
  narratableSteps: CinematicStep[];
  groups: number[][];
  videoSeconds: number;
  log: Logger;
  echo?: Echo;
}): Promise<
  | {
      direction: ReturnType<typeof resolveDirection>;
      lyrics: Lyrics;
      repoDir: string;
      base: string;
    }
  | { error: string }
> {
  const { options, narratableSteps, groups, videoSeconds, log, echo } = args;
  const direction = resolveDirection(options.prompt, { song: true });
  const repoDir = options.repoDir ?? process.cwd();
  const base = await resolveBase(repoDir);
  const change = (await describeChange(repoDir, base)) ?? undefined;
  // One prompt entry (and one lyric line) PER GROUP, not per step.
  const prompt = buildLyricsPrompt({
    direction: direction.text,
    change,
    videoSeconds,
    steps: groupedLyricSteps(narratableSteps, groups),
  });
  const result = await runClaudeJson({
    label: "lyrics",
    prompt,
    schema: LYRICS_SCHEMA,
    parse: parseLyricsJson,
    log,
    echo,
  });
  if ("error" in result) {
    return { error: result.error };
  }
  return { direction, lyrics: result.value, repoDir, base };
}

// A friendly source name for the music provider, for the "Made with" block.
function musicToolName(id: string | undefined): string | undefined {
  switch (id) {
    case "archive-music":
      return "Music — archive.org (Creative Commons)";
    case "acestep-music":
      return "Music — ACE-Step 1.5 (local)";
    case "gemini-music":
      return "Music — Lyria (Google Gemini)";
    default:
      return;
  }
}

// A friendly voice credit from the TTS provider id + its reproducibility label
// (the label already encodes the model/voice, e.g. "omlx:<model>" or a `say`
// voice like "Ava (Premium)" or "<command>:<voice>"). Pure → unit-tested.
export function voiceCredit(
  ttsId: string | undefined,
  voiceLabel: string
): string {
  const label = voiceLabel.trim();
  if (ttsId === "omlx-tts") {
    return `Voice — oMLX ${label.replace(/^omlx:/, "")}`.trim();
  }
  if (ttsId === "gemini-tts") {
    return `Voice — ${label.replace(/^gemini:/, "")} (Google Gemini)`;
  }
  // macOS `say` (or a $DAILIES_SAY_COMMAND override): the label is the voice/command.
  return label ? `Voice — ${label}` : "Voice — system speech";
}

// The "Made with" tool credits actually used this run. The `claude` CLI always
// writes the words (narration, or lyrics in song mode); voice/music/title-art
// depend on what was resolved. In song mode there's no spoken voice, so the voice
// line is dropped and the music (the sung song) is primary. Pure → unit-tested.
//
// `hasMusicCredit` is set when a dedicated "Music" credit section already names
// the score (the provider's credit() line — a specific archive.org track, or the
// model name for ACE-Step/Lyria). In that case the generic "Music — <tool>" line
// here is redundant (it was crediting ACE-Step/Lyria a second time), so it's
// dropped and the richer section stands alone.
export function buildModelCredits(args: {
  voiceLabel: string;
  ttsId: string | undefined;
  musicId: string | undefined;
  // The title-background provider id when a background was actually rendered
  // (undefined for the solid-color fallback). Only a GENERATED image earns a
  // credit; the built-in local gradient is a fallback, not a tool, so it's not
  // credited (like the drawtext/solid card it replaces).
  titleArtId: string | undefined;
  song?: boolean;
  hasMusicCredit?: boolean;
}): string[] {
  const models = [
    args.song
      ? "Lyrics — Claude (Anthropic)"
      : "Narration — Claude (Anthropic)",
  ];
  if (!args.song) {
    models.push(voiceCredit(args.ttsId, args.voiceLabel));
  }
  const music = args.hasMusicCredit ? undefined : musicToolName(args.musicId);
  if (music) {
    models.push(music);
  }
  const titleArt = titleArtToolName(args.titleArtId);
  if (titleArt) {
    models.push(titleArt);
  }
  return models;
}

// A friendly credit for the title-background source, for the "Made with" block.
// Generated (Gemini/local model) and stock (Wikimedia) sources are credited; the
// built-in local gradient and the solid fallback are not tools. Pure → tested.
export function titleArtToolName(id: string | undefined): string | undefined {
  switch (id) {
    case "gemini-image":
      return "Title art — Nano Banana (Google Gemini)";
    case "local-image":
      return "Title art — local image model";
    case "wikimedia-image":
      return "Title art — Wikimedia Commons (CC)";
    default:
      return;
  }
}

// Append a scrolling end-credits roll after the body. The caller assembles the
// sections (contributors + music + tools), so this just renders and concatenates.
// Best-effort: returns the body unchanged when there's nothing to credit or on
// any failure. Credits sit at the very end, so they don't shift any step's
// videoTime.
async function appendCredits(args: {
  ffmpeg: string;
  body: string;
  videoPath: string;
  heading: string;
  sections: CreditSection[];
  geometry: ProbedVideo;
  temps: string[];
  log: Logger;
}): Promise<string> {
  const { ffmpeg, body, videoPath, heading, sections, geometry, temps, log } =
    args;
  if (!sections.some((s) => s.entries.length > 0)) {
    return body;
  }
  try {
    const creditsPath = `${videoPath}.credits.webm`;
    temps.push(creditsPath);
    await buildCreditsRoll({
      ffmpeg,
      sections,
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

// Push music tracks past the opening title card: the score is timed against the
// body, but it's mixed onto the title-prefixed final video, so add the title
// offset to each track's delay and its fade envelope. Pure.
function shiftMusic(tracks: MusicTrack[], leadSec: number): MusicTrack[] {
  if (leadSec <= 0) {
    return tracks;
  }
  const add = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : v + leadSec;
  return tracks.map((t) => ({
    ...t,
    delaySec: t.delaySec + leadSec,
    fadeInAtSec: add(t.fadeInAtSec),
    fadeOutAtSec: add(t.fadeOutAtSec),
  }));
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
  // ONE song for the whole video (no second download): fetch a single bed, play
  // it quietly UNDER the narration, then swell to full volume for the credits.
  const bedPath = `${videoPath}.bed.wav`;
  temps.push(bedPath);
  try {
    await provider.bed(directionText, total, bedPath);
  } catch (err) {
    log.debug({ err }, "cinematic: instrumental score unavailable");
    notes.push("instrumental score unavailable");
    return [];
  }
  const creditsStart = await audioDurationSec(ffmpeg, bodyPath);
  const hasCredits = Boolean(creditsStart && total - creditsStart > 1);
  if (!hasCredits) {
    // No credits region — just the quiet bed under the whole thing.
    return [{ path: bedPath, delaySec: 0, volume: NARRATION_MUSIC_GAIN }];
  }
  const cs = creditsStart as number;
  const ramp = MUSIC_SWELL_RAMP_SEC;
  // Narration bed: quiet, faded out just before the credits so it doesn't stack
  // with the swell below it.
  const tracks: MusicTrack[] = [
    {
      path: bedPath,
      delaySec: 0,
      volume: NARRATION_MUSIC_GAIN,
      fadeOutAtSec: Math.max(0, cs - ramp),
      fadeOutDurSec: ramp,
    },
  ];
  // Credits swell: the SAME song, seeked to its loudest (≈ highest-energy)
  // window so the credits open on a strong section, at full volume, fading in at
  // the credits start. One download → quiet bed + a full-energy credits swell.
  try {
    const creditsLen = total - cs;
    const loudOff = await pickLoudestOffset(ffmpeg, bedPath, creditsLen);
    const creditsClip = `${videoPath}.credits.wav`;
    temps.push(creditsClip);
    await trimAudio({
      ffmpeg,
      src: bedPath,
      startSec: loudOff,
      outPath: creditsClip,
      echo: args.progress,
    });
    tracks.push({
      path: creditsClip,
      delaySec: cs,
      volume: CREDITS_MUSIC_GAIN,
      fadeInAtSec: cs,
      fadeInDurSec: ramp,
    });
  } catch (err) {
    // Couldn't make the swell — let the quiet bed carry the credits too (drop
    // its fade-out so it doesn't cut to silence).
    log.debug({ err }, "cinematic: credits swell unavailable; bed continues");
    tracks[0] = { path: bedPath, delaySec: 0, volume: NARRATION_MUSIC_GAIN };
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
  voiceLabel: string;
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
    voiceLabel,
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
    gapSec: narrationGapSec(process.env),
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
    // The local gradient is already dark by design; only dim external photos.
    dimBackground: providers.titleBackground?.id !== "local-gradient",
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
    // Resolve the music credit WITHOUT generating audio (the provider caches its
    // pick so generateMusic below reuses the credited track), then assemble the
    // sections: people, music, and the tools actually used this run.
    const musicCredit = await providers.music
      ?.credit?.(directionText)
      .catch(() => undefined);
    const sections = buildCreditSections({
      contributors: await branchContributors(repoDir, base),
      music: musicCredit,
      models: buildModelCredits({
        voiceLabel,
        ttsId: providers.tts?.id,
        musicId: providers.music?.id,
        titleArtId: background ? providers.titleBackground?.id : undefined,
        hasMusicCredit: Boolean(musicCredit),
      }),
    });
    finalBody = await appendCredits({
      ffmpeg,
      body,
      videoPath,
      heading: title,
      sections,
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

// The minimum a generated song should run — 1:30. A short session still gets a
// full-length piece rather than a song that ends early.
export const MIN_SONG_SEC = 90;

// The maximum song length to REQUEST. The model honors the duration exactly, so an
// unbounded request would literally generate that many seconds (a long session ×
// ~5s/step reaches minutes) only for the caller to trim most of it to the sung
// region. Cap it: the distinct written lines are exhausted within ~1–2 minutes
// regardless (the rest repeats), so a longer request buys nothing but generation
// time. 2:45 leaves comfortable headroom over MIN_SONG_SEC.
export const MAX_SONG_SEC = 165;

// Song length to request from the music provider. Honored exactly by ACE-Step
// (and used as the target by Gemini Lyria), so it sets the real generated length.
// Scaled to the LYRIC-LINE count (not the step count): the lines are the actual
// sung content — a title lead-in + ~9s of singing per line + an outro — clamped to
// [MIN_SONG_SEC, MAX_SONG_SEC]. Sizing off steps overshot badly (a 26-step / 11-line
// session asked for 148s but the 11 lines were sung by ~93s, leaving a dead
// instrumental tail); sizing off lines keeps the song about as long as there are
// words to sing. The caller still trims any residual tail to the last sung line.
// Pure → unit-tested.
export function songTargetSec(lineCount: number): number {
  const scaled = Math.round(TITLE_SEC + Math.max(0, lineCount) * 9 + 12);
  return Math.min(MAX_SONG_SEC, Math.max(MIN_SONG_SEC, scaled));
}

// Generate the raw SONG file (the model SINGS the supplied lyrics). Returns its
// path, or null on failure. The length is what we REQUEST (`targetSec`) — ACE-Step
// honors the duration exactly and still sings — so the file is that long, singing
// the lyrics and then repeating to fill any remainder; the caller transcribes and
// trims that tail back to the last distinct sung line.
async function generateRawSong(args: {
  provider: MusicProvider | undefined;
  directionText: string;
  lyrics: string;
  targetSec: number;
  outPath: string;
  temps: string[];
  notes: string[];
  log: Logger;
}): Promise<{ path: string; lrcText?: string } | null> {
  const {
    provider,
    directionText,
    lyrics,
    targetSec,
    outPath,
    temps,
    notes,
    log,
  } = args;
  if (!provider) {
    return null;
  }
  temps.push(outPath);
  try {
    // The length is what we request (honored exactly by ACE-Step); the model sings
    // the lyrics then repeats to fill, and the caller trims the tail. The provider
    // may also hand back its OWN per-line lyric timestamps (LRC) — the ideal caption
    // source; the caller uses them when present, else transcribes.
    const result = await provider.song(
      directionText,
      targetSec,
      outPath,
      lyrics
    );
    return { path: outPath, lrcText: result?.lrcText };
  } catch (err) {
    log.debug({ err }, "cinematic: song generation failed");
    notes.push("song unavailable — generation failed");
    return null;
  }
}

// Song-mode counterpart of assembleVideo. RE-TIMES the body like narration — each
// step's frame holds for `holdDurSec[i]` — so the body is long enough for the
// song's vocals to play across it and the captions get readable spacing. Then
// prepend the title and append the credits. The SONG itself is generated, timed,
// and mixed by the caller (it needs the song's transcript first); this just builds
// the silent video. Returns the final body, each step's new position, and the
// title offset — or null if the source can't be probed/re-timed.
async function assembleSongVideo(args: {
  ffmpeg: string;
  videoPath: string;
  narratableSteps: CinematicStep[];
  holdDurSec: number[];
  // Song step-sync: per-step onset (output start, = when each step's line is sung)
  // and the body end — the body is onset-anchored so each step's footage is on screen
  // while its lyric line is sung.
  onsets?: number[];
  bodyEnd?: number;
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
  titleOffsetSec: number;
} | null> {
  const {
    ffmpeg,
    videoPath,
    narratableSteps,
    holdDurSec,
    onsets,
    bodyEnd,
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

  const geometry = await probeVideo(ffmpeg, videoPath);
  const frameRate = geometry?.frameRate ?? 30;

  // Re-time the body: each step plays at natural speed then freezes its last frame to
  // fill its budget (preserving motion + quality). When `onsets` are given (the
  // transcribed path) the body is ANCHORED to each line's sung moment (hard-cut) so
  // the on-screen step tracks what's being sung — the song-mode analog of narration's
  // per-step hold; otherwise it falls back to the even `holdDurSec` split.
  progress("re-timing the video to the song…");
  const retimed = await retimeForNarration({
    ffmpeg,
    videoPath,
    steps: narratableSteps,
    clipDurSec: holdDurSec,
    frameRate,
    temps,
    onsets,
    bodyEnd,
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
    // The local gradient is already dark by design; only dim external photos.
    dimBackground: providers.titleBackground?.id !== "local-gradient",
    hasDrawtext,
    geometry,
    temps,
    notes,
    log,
  });

  const stepTimes = retimed.starts.map((s) => s + titleOffsetSec);

  let finalBody = body;
  if (hasDrawtext && geometry) {
    progress("rolling the credits…");
    const musicCredit = await providers.music
      ?.credit?.(directionText)
      .catch(() => undefined);
    const sections = buildCreditSections({
      contributors: await branchContributors(repoDir, base),
      music: musicCredit,
      models: buildModelCredits({
        voiceLabel: "",
        ttsId: undefined,
        musicId: providers.music?.id,
        titleArtId: background ? providers.titleBackground?.id : undefined,
        song: true,
        hasMusicCredit: Boolean(musicCredit),
      }),
    });
    finalBody = await appendCredits({
      ffmpeg,
      body,
      videoPath,
      heading: title,
      sections,
      geometry,
      temps,
      log,
    });
  }

  return { finalBody, stepTimes, titleOffsetSec };
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
  // Optional cross-fade envelope (see AudioTrack), on the global timeline.
  fadeInAtSec?: number;
  fadeInDurSec?: number;
  fadeOutAtSec?: number;
  fadeOutDurSec?: number;
  path: string;
  volume: number;
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

  // Speak a for-the-ear rewrite; the caption/return value keeps the original.
  await synth.run(speechText(narration), rawPath);
  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
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
  const {
    ffmpeg,
    say,
    tts,
    steps,
    byIndex,
    videoPath,
    temps,
    notes,
    log,
    echo,
  } = args;
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
  // Darken the background before overlaying text. On by default for arbitrary
  // (often bright) generated photos; skipped for the local gradient, which is
  // already dark by design — dimming it further just muddies the card.
  dimBackground?: boolean;
  temps: string[];
  outPath: string;
}): Promise<void> {
  const {
    ffmpeg,
    title,
    style,
    geometry,
    background,
    dimBackground = true,
    temps,
    outPath,
  } = args;
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

  // Base layer: a provided background image (scaled to fill, darkened when it's
  // an arbitrary photo so white text reads), else a solid black frame.
  const dim = dimBackground ? "eq=brightness=-0.25," : "";
  const filter = background
    ? `scale=${geometry.width}:${geometry.height}:force_original_aspect_ratio=increase,crop=${geometry.width}:${geometry.height},${dim}drawtext=${drawtext},fps=${geometry.frameRate},setpts=N/FRAME_RATE/TB`
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
      ...FFMPEG_BASE_ARGS,
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

// Compute, for each step (sorted by videoTime), where its footage now begins in
// the re-timed video and how long to freeze its tail. A step's natural footage
// is [videoTime, nextVideoTime) (last step runs to the end); when its narration
// is longer than that, the difference is added as a freeze hold so narration
// never bleeds into the next step. `startPadSec` freezes the first frame for a
// beat BEFORE each step's footage (so the action doesn't start cold); the
// returned `starts` point at the action (after that pad), where narration/captions
// land.
//
// `gapSec` guarantees a MINIMUM silent beat between consecutive narration clips:
// without it, a step whose line runs longer than its footage holds only exactly
// long enough for the line, so the next line starts the instant this one ends and
// the narration sounds breathless. Adding `gapSec` to each non-last step's hold
// floors the inter-clip gap at `gapSec` (and adds nothing when the footage already
// leaves that much slack — `clipDur − f + gapSec` goes ≤ 0, so the hold stays 0
// and the natural gap already covers it). The last step gets no trailing gap.
// Pure → unit-tested.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-step hold arithmetic with its documented edge cases (last step, slack already in the footage) kept inline, where the comment above explains them against the formula.
export function planRetime(args: {
  stepTimes: number[];
  clipDurSec: number[];
  totalSec: number;
  startPadSec?: number;
  gapSec?: number;
  // ONSET-ANCHORED mode (song step-sync): the output time each step must START at
  // (the moment its lyric line is sung). When given, each step plays its natural
  // footage from `stepTimes[i]` but is HARD-CUT at the next onset — clipping the
  // footage tail if it overran the window, freeze-padding if it underran — so the
  // step is on screen exactly while its line is sung. Every step re-anchors to an
  // absolute onset, so timing error is bounded per step (no cumulative drift).
  // `bodyEnd` closes the last step's window. Overrides the narration hold logic.
  onsets?: number[];
  bodyEnd?: number;
}): { starts: number[]; footage: number[]; holds: number[]; leadSec: number } {
  const { stepTimes, clipDurSec, totalSec, onsets, bodyEnd } = args;
  const startPad = Math.max(0, args.startPadSec ?? 0);
  const gap = Math.max(0, args.gapSec ?? 0);
  const n = stepTimes.length;
  const starts: number[] = [];
  const footage: number[] = [];
  const holds: number[] = [];

  if (onsets && onsets.length === n) {
    // Onset-anchored hard-cut. The lead is the instrumental run before the first
    // line; each step fills [onset_i, onset_{i+1}) by playing min(footage, window)
    // then freezing the remainder.
    const leadSec = Math.max(0, onsets[0] ?? 0);
    const end = bodyEnd ?? totalSec;
    for (let i = 0; i < n; i++) {
      const src = stepTimes[i] ?? 0;
      const srcNext = i < n - 1 ? (stepTimes[i + 1] ?? totalSec) : totalSec;
      const natural = Math.max(0.1, srcNext - src);
      const winStart = onsets[i] ?? 0;
      const winEnd = i < n - 1 ? (onsets[i + 1] ?? end) : end;
      const slot = Math.max(0.1, winEnd - winStart);
      const play = Math.min(natural, slot); // clip the tail on overrun
      starts.push(winStart);
      footage.push(play);
      holds.push(Math.max(0, slot - play)); // freeze-pad on underrun
    }
    return { starts, footage, holds, leadSec };
  }

  const leadSec = n > 0 ? Math.max(0, stepTimes[0] ?? 0) : 0;
  let acc = leadSec;
  for (let i = 0; i < n; i++) {
    const start = stepTimes[i] ?? 0;
    const next = i < n - 1 ? (stepTimes[i + 1] ?? totalSec) : totalSec;
    const f = Math.max(0.1, next - start);
    // No trailing gap after the final clip (nothing follows it to breathe from).
    const isLast = i === n - 1;
    const hold = Math.max(0, (clipDurSec[i] ?? 0) - f + (isLast ? 0 : gap));
    // The action (and its narration) starts after the leading still.
    starts.push(acc + startPad);
    footage.push(f);
    holds.push(hold);
    acc += startPad + f + hold;
  }
  return { starts, footage, holds, leadSec };
}

// Leading still pad before each step's action. DISABLED (0): freezing the first
// frame of a step froze a mid-typing frame ("one character, then a pause"), since
// a step's window often opens partway into its own keystrokes. End-freeze only —
// exactly like cinematic/narration mode — keeps the motion clean.
const STEP_START_PAD_SEC = 0;

// Minimum silent beat held between consecutive narration lines so they don't run
// together (a short step's line used to end and the next begin in the same frame).
// A freeze on the current step's last frame fills the gap. Override with
// $DAILIES_NARRATION_GAP_SEC (0 restores the old back-to-back pacing).
const DEFAULT_NARRATION_GAP_SEC = 0.6;
export function narrationGapSec(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.DAILIES_NARRATION_GAP_SEC);
  return Number.isFinite(override) && override >= 0
    ? override
    : DEFAULT_NARRATION_GAP_SEC;
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
  // Minimum silent beat between consecutive lines (narration mode passes a value;
  // song mode leaves it 0 — the song's own pacing carries the gaps).
  gapSec?: number;
  // Song step-sync: per-step onset (where each step must start in the output) and
  // the body end. When given, planRetime hard-cuts each step to its onset window.
  onsets?: number[];
  bodyEnd?: number;
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
    startPadSec: STEP_START_PAD_SEC,
    gapSec: args.gapSec,
    onsets: args.onsets,
    bodyEnd: args.bodyEnd,
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
      startHoldSec: STEP_START_PAD_SEC,
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
  dimBackground?: boolean;
  geometry: ProbedVideo;
  temps: string[];
}): Promise<string> {
  const {
    ffmpeg,
    videoPath,
    title,
    style,
    background,
    dimBackground,
    geometry,
    temps,
  } = args;
  const titlePath = `${videoPath}.title.webm`;
  temps.push(titlePath);
  await buildTitleCard({
    ffmpeg,
    title,
    style,
    background,
    dimBackground,
    geometry,
    temps,
    outPath: titlePath,
  });
  const concatPath = `${videoPath}.concat.webm`;
  const listPath = `${videoPath}.concat.txt`;
  temps.push(concatPath, listPath);
  await concatSegments(ffmpeg, [titlePath, videoPath], concatPath, listPath);
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
  dimBackground?: boolean;
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
    dimBackground,
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
      dimBackground,
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
      fadeInAtSec: m.fadeInAtSec,
      fadeInDurSec: m.fadeInDurSec,
      fadeOutAtSec: m.fadeOutAtSec,
      fadeOutDurSec: m.fadeOutDurSec,
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

  // Bound the output to the video's length. amix uses duration=longest, and a
  // music provider may return a track far longer than the video (e.g. ACE-Step
  // ignores the requested duration and returns minutes of audio) — without this
  // cap that music keeps playing for minutes after the credits end.
  const videoDurSec = await audioDurationSec(ffmpeg, videoPath);
  const durationCap = videoDurSec ? ["-t", videoDurSec.toFixed(3)] : [];

  await run(
    ffmpeg,
    [
      ...FFMPEG_BASE_ARGS,
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
      ...durationCap,
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

// Sidecar path for the song-mode lyrics, beside the video. In song mode the
// generated vocals carry no alignment data, so rather than fake time-synced
// captions we write the lyrics here as the honest text artifact.
export function lyricsPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.lyrics.txt`;
}

// Sidecar path holding the pre-cinematic (condensed) cut, beside the video. The
// cinematic pass preserves the condensed video here on its first run so it can be
// re-run with a different prompt/theme from the clean source — never stacking a
// title card / captions on a previous cinematic cut. Not a recorded artifact, so
// condense (which works off the artifact list) never touches it.
export function precinematicVideoPath(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.precinematic${ext}`;
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the cinematic pipeline's entry point — every stage (title card, narration, music, captions) is independently optional and degrades instead of throwing, so the per-stage fallbacks land here. At a cognitive complexity of 85 this is the most complex function in the repo and the clearest refactor target.
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
    // Preserve the pre-cinematic (condensed) cut so this pass can be re-run with
    // a different prompt/theme without re-recording. First run: copy the
    // condensed videoPath to the sidecar. Re-run: the sidecar already exists, so
    // read FROM it — never stacking a title card / captions on a prior cinematic
    // cut. The output still overwrites videoPath; the sidecar stays pristine.
    const preserved = precinematicVideoPath(videoPath);
    let input = videoPath;
    try {
      await access(preserved);
      input = preserved;
    } catch {
      await copyFile(videoPath, preserved);
    }
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
    const acestep = await resolveAceStepMusic({ env: process.env, log, echo });
    const gemini = resolveMediaProviders({ env: process.env, log });
    // Title-background sources: a configured local image server ($DAILIES_IMAGE_URL)
    // wins (explicit user config), then Gemini (Nano Banana), then Wikimedia
    // Commons real imagery; the always-available local gradient is added later
    // (once the theme is known) as the final fallback.
    const localImage = resolveLocalImage({ env: process.env, log, echo });
    // Stock/free fallbacks: archive.org music and Wikimedia images turn ON
    // automatically when no corresponding AI MODEL is configured, so a plain
    // `--cinematic` run still gets a score + real title imagery with no key/GPU.
    // An explicit $DAILIES_ARCHIVE_MUSIC/$DAILIES_WIKIMEDIA_IMAGES=1 forces them on
    // (and, for music, takes precedence over the models); =0 forces them off.
    // Both push per-track attribution into `notes` at fetch time by reference.
    const archive = resolveArchiveMusic({
      env: process.env,
      ffmpeg: ffmpegPath,
      log,
      notes,
      echo,
      allowFallback: !(acestep.music || gemini.music),
    });
    const wikimedia = resolveWikimediaImage({
      env: process.env,
      notes,
      log,
      echo,
      allowFallback: !(localImage.titleBackground || gemini.titleBackground),
    });
    const providers: MediaProviders = {
      tts: omlx.tts ?? gemini.tts,
      // Prefer stock (archive.org) when opted in, then generated (ACE-Step),
      // then Gemini Lyria.
      music: archive.music ?? acestep.music ?? gemini.music,
      titleBackground:
        localImage.titleBackground ??
        gemini.titleBackground ??
        wikimedia.titleBackground,
      notes: [],
    };
    notes.push(...omlx.notes, ...acestep.notes);
    // Surface Gemini's notes only when Gemini is actually active, or when there's
    // genuinely no local alternative — otherwise its "no key → using say … and no
    // music" note contradicts the oMLX/ACE-Step/archive providers above.
    if (gemini.tts) {
      notes.push(...gemini.notes);
    } else if (!(omlx.tts || providers.music)) {
      notes.push(...gemini.notes);
    }

    // Song mode: instead of per-step spoken narration, the LLM writes one short
    // themed lyric line per step-GROUP and a singing music model (ACE-Step, with LM
    // planning on for adherence) performs them as the whole soundtrack. We find where
    // each line is actually sung (the model's LRC timestamps floored by whisper
    // word-onsets, else word/segment alignment), burn captions at those times, and
    // onset-anchor the body so each group's footage is on screen while its line plays.
    if (options.song) {
      // Pick a music provider that actually SINGS supplied lyrics (ACE-Step /
      // Lyria), ignoring stock music (archive.org) even if it won the normal
      // chain — it can't sing custom words.
      const songMusic = [acestep.music, gemini.music].find(
        (m) => m?.singsLyrics
      );
      if (!songMusic) {
        return notApplied(
          "song mode needs a lyrics-capable music model — start the ACE-Step server (set DAILIES_ACESTEP_URL for a non-default port) or set GEMINI_API_KEY"
        );
      }
      const songProviders: MediaProviders = {
        music: songMusic,
        // Same background chain as the narration path (local image → Gemini →
        // Wikimedia; local gradient added later as the fallback).
        titleBackground:
          localImage.titleBackground ??
          gemini.titleBackground ??
          wikimedia.titleBackground,
        notes: [],
      };

      // Group short consecutive steps so one sung line spans >= GROUP_MIN_SEC —
      // fewer, longer verses instead of a frantic line per tiny step. Grouping
      // is deterministic for a recording, so a pinned-song reuse maps back the
      // same way.
      const groups = groupStepsForLyrics(
        stepFootageSec(narratableSteps),
        GROUP_MIN_SEC
      );

      // 0. Lyrics + direction: reuse a pinned song's saved lyrics when
      // $DAILIES_SONG_FILE points at an existing song (+ its .json), else plan
      // fresh. Pinning lets an A/B reuse the SAME song + lyrics and vary only the
      // re-timing (and avoids regenerating while iterating).
      const pinnedSong = process.env.DAILIES_SONG_FILE?.trim();
      const songCache = pinnedSong ? `${pinnedSong}.json` : "";
      let direction: ReturnType<typeof resolveDirection>;
      let lyrics: Lyrics;
      let repoDir: string;
      let base: string;
      const reusing = Boolean(
        pinnedSong && existsSync(pinnedSong) && existsSync(songCache)
      );
      let lrcText: string | undefined;
      if (reusing) {
        const saved = JSON.parse(await readFile(songCache, "utf8")) as {
          direction: ReturnType<typeof resolveDirection>;
          lyrics: Lyrics;
          lrcText?: string;
        };
        direction = saved.direction;
        lyrics = saved.lyrics;
        lrcText = saved.lrcText;
        repoDir = options.repoDir ?? process.cwd();
        base = await resolveBase(repoDir);
        notes.push(`reusing pinned song (${pinnedSong})`);
      } else {
        // Size the lyric word-budget to the re-timed body length (one line per
        // GROUP, ~GROUP_MIN_SEC each), not the (often tiny) condensed input.
        const videoSeconds = Math.max(8, groups.length * GROUP_MIN_SEC);
        progress("writing the lyrics…");
        const planned = await planSong({
          options,
          narratableSteps,
          groups,
          videoSeconds,
          log,
          echo,
        });
        if ("error" in planned) {
          return notApplied(`song lyrics generation failed: ${planned.error}`);
        }
        direction = planned.direction;
        lyrics = planned.lyrics;
        repoDir = planned.repoDir;
        base = planned.base;
      }

      // One entry per GROUP that got a line (the lyric index is the group
      // ordinal); `stepIdxs` are the steps it spans and `firstStep` anchors its
      // caption on the timeline. The lyric block the model sings is these group
      // lines in order (a [verse] tag helps the model).
      const byGroup = new Map(lyrics.lines.map((l) => [l.index, l.text]));
      const ordered = groups
        .map((stepIdxs, g) => ({
          firstStep: stepIdxs[0] ?? 0,
          stepIdxs,
          text: byGroup.get(g),
        }))
        .filter(
          (x): x is { firstStep: number; stepIdxs: number[]; text: string } =>
            Boolean(x.text)
        );
      const orderedTexts = ordered.map((x) => x.text);
      const lyricBlock = `[verse]\n${orderedTexts.join("\n")}`;

      const musicLabel =
        (await songMusic.credit?.(direction.theme).catch(() => undefined)) ??
        songMusic.id;
      const meta: CinematicMeta = {
        direction: direction.label,
        voice: "",
        rate: 0,
        song: true,
        music: musicLabel,
      };
      log.info(meta, "cinematic: song parameters");

      // 1. The raw song. Reuse the pinned file, or generate (duration honored; the
      // model may also return its own LRC lyric timestamps) and persist when pinning.
      let rawSong: string;
      if (reusing && pinnedSong) {
        rawSong = pinnedSong;
      } else {
        progress("composing the song…");
        const generated = await generateRawSong({
          provider: songMusic,
          directionText: direction.theme,
          lyrics: lyricBlock,
          // Size the song to the LYRIC LINES (the sung content), not the step count.
          targetSec: songTargetSec(orderedTexts.length),
          outPath: `${videoPath}.rawsong.wav`,
          temps,
          notes,
          log,
        });
        if (!generated) {
          // No song audio means song mode produced nothing — skip and keep the
          // plain condensed cut rather than ship a silent "song" video.
          return notApplied("song audio could not be generated");
        }
        rawSong = generated.path;
        lrcText = generated.lrcText;
        if (pinnedSong) {
          await copyFile(generated.path, pinnedSong);
          await writeFile(
            songCache,
            JSON.stringify({ direction, lyrics, lrcText })
          );
          rawSong = pinnedSong;
        }
      }

      // 2. Caption source + vocal region. Transcribe (best-effort), then pick the
      // best timing source (LRC → word → segment) — see selectSongCaptions.
      progress("listening for the vocals…");
      const transcript = await transcribeSong({
        audioPath: rawSong,
        ffmpeg: ffmpegPath,
        env: process.env,
        echo,
      });
      // $DAILIES_ACESTEP_LRC=0 forces the transcribe path even when LRC is present.
      const { region, clipCues, sourceLabel } = selectSongCaptions({
        orderedTexts,
        lrcText,
        useLrc: process.env.DAILIES_ACESTEP_LRC?.trim() !== "0",
        segments: transcript?.segments ?? [],
        words: transcript?.words ?? [],
        leadSec: TITLE_SEC + 0.5,
        maxCueSec: MAX_CUE_SEC,
      });

      // 3. Per-step holds + rebased cues.
      const stepCount = Math.max(1, narratableSteps.length);
      let songClip = rawSong;
      let alignedCues: { start: number; end: number; text: string }[] | null =
        null;
      let holdDurSec: number[];
      let songOnsets: number[] | undefined;
      let songBodyEnd: number | undefined;
      if (region) {
        const trimStart = region.start;
        if (trimStart > 0.05) {
          songClip = `${videoPath}.song.wav`;
          temps.push(songClip);
          await trimAudio({
            ffmpeg: ffmpegPath,
            src: rawSong,
            startSec: trimStart,
            outPath: songClip,
            echo,
          });
        }
        // Rebase to the trimmed song by a pure time shift (it plays at delay 0, so
        // clip time maps to the final-video time before the title shift), and cap
        // each cue at MAX_CUE_SEC. The cap matters most for LRC/segment cues, whose
        // end is the NEXT line's start: when the model leaves a long instrumental
        // gap between sung lines, an uncapped cue would linger ~20s on screen — cap
        // it so the line shows, then clears (the word path is already capped).
        alignedCues = clipCues
          .map((c) => {
            const start = c.start - trimStart;
            const end = Math.min(c.end - trimStart, start + MAX_CUE_SEC);
            return { start, end, text: c.text };
          })
          .filter((c) => c.end > 0)
          .map((c) => ({
            start: Math.max(0, c.start),
            end: c.end,
            text: c.text,
          }));
        const bodyLen = Math.max(6, region.end - region.start);
        holdDurSec = Array.from(
          { length: stepCount },
          () => bodyLen / stepCount
        );
        // Onset-anchored step-sync: map each group to when its line is actually
        // sung (walk groups against the aligned cues — a subsequence of the group
        // lines, in order), so the re-time can hold each step's footage on screen
        // exactly while its line plays. bodyEnd trims to just past the last sung
        // line, dropping the instrumental outro.
        if (alignedCues.length > 0) {
          const groupSungStart: (number | null)[] = groups.map(() => null);
          let ci = 0;
          for (let g = 0; g < groups.length; g++) {
            const text = byGroup.get(g);
            if (text && alignedCues[ci]?.text === text) {
              groupSungStart[g] = alignedCues[ci]?.start ?? null;
              ci++;
            }
          }
          songBodyEnd = Math.max(...alignedCues.map((c) => c.end)) + 2;
          songOnsets = songStepOnsets(groups, groupSungStart, songBodyEnd);
        }
        notes.push(
          `captions aligned to ${sourceLabel} (${alignedCues.length}/${orderedTexts.length} lines sung)`
        );
      } else {
        // No transcription: keep the raw song (capped by the mix), and re-time so
        // each GROUP is held long enough to sing its line (at least the group
        // minimum), split across the group's steps. Captions land at group
        // starts. Steps in a group with no line keep a small default.
        holdDurSec = Array.from({ length: stepCount }, () => 3.5);
        for (const grp of ordered) {
          const groupHold = Math.max(GROUP_MIN_SEC, songHoldSec(grp.text));
          const per = groupHold / grp.stepIdxs.length;
          for (const i of grp.stepIdxs) {
            holdDurSec[i] = per;
          }
        }
        notes.push(
          "vocal timing not detected (no whisper model) — captions placed at step times; set $DAILIES_WHISPER_MODEL to align them to the singing"
        );
      }

      // 4. Build the (silent) video around the song: re-time, title, credits.
      // Same local-gradient default as the narration path (see above).
      songProviders.titleBackground ??= createLocalTitleBackground(
        ffmpegPath,
        direction.category
      );
      const assembled = await assembleSongVideo({
        ffmpeg: ffmpegPath,
        videoPath: input,
        narratableSteps,
        holdDurSec,
        onsets: songOnsets,
        bodyEnd: songBodyEnd,
        title: lyrics.title,
        category: direction.category,
        directionText: direction.theme,
        providers: songProviders,
        hasDrawtext,
        repoDir,
        base,
        temps,
        notes,
        log,
        progress,
      });
      if (!assembled) {
        return notApplied("could not probe the video to build the song cut");
      }
      const { finalBody, stepTimes, titleOffsetSec } = assembled;

      // 5. Captions: the vocal-aligned cues when we have them, else step-timed.
      // The sibling .srt is ALWAYS written beside the video (a deliverable for
      // editing / soft-sub players) — this is the documented contract.
      // --no-captions only skips BURNING the captions into the pixels, not the
      // .srt. We also BURN them (when this ffmpeg can) so they're visible in any
      // player, since a sibling .srt isn't loaded by QuickTime or the report
      // viewer.
      const wantCaptions = options.captions !== false;
      const srtPath = srtPathFor(videoPath);
      let wroteSrt = false;
      let burnCaptions = false;
      const srtGeometry = await probeVideo(ffmpegPath, input);
      // Vocal-aligned cues when we actually matched some; otherwise step-timed
      // (e.g. whisper found no usable lyrics in an instrumental-leaning song).
      const cues =
        alignedCues && alignedCues.length > 0
          ? // Vocal-aligned cues are song-relative (0-based); the song is delayed
            // past the title card below, so shift them by the same offset. (The
            // step-timed fallback already uses stepTimes, which include it.)
            alignedCues.map((c) => ({
              start: c.start + titleOffsetSec,
              end: c.end + titleOffsetSec,
              text: c.text,
            }))
          : layoutSongCues(
              ordered.map((x) => ({
                start: stepTimes[x.firstStep] ?? 0,
                text: x.text,
              })),
              (await audioDurationSec(ffmpegPath, finalBody)) ?? 0
            );
      if (cues.length > 0) {
        temps.push(srtPath);
        await writeFile(
          srtPath,
          buildSrt(cues, captionLineMax(srtGeometry?.width))
        );
        wroteSrt = true;
        burnCaptions = wantCaptions && hasSubtitles;
        if (wantCaptions && !hasSubtitles) {
          const note =
            "captions not burned — this ffmpeg has no `subtitles` filter; wrote a soft-sub .srt instead";
          notes.push(note);
          log.warn({ ffmpeg: ffmpegPath }, `cinematic: ${note}`);
        }
      } else {
        // Nothing to caption — drop any stale .srt from a prior run.
        await rm(srtPath, { force: true });
      }

      // 6. Write the full lyrics sidecar (one line per step, in order).
      const lyricsPath = lyricsPathFor(videoPath);
      temps.push(lyricsPath);
      await writeFile(
        lyricsPath,
        `${lyrics.title}\n\n${orderedTexts.join("\n")}\n`
      );

      // 7. Mix the song under the video and burn the captions. The mix's -t cap
      // trims the long song down to the video length.
      progress(
        burnCaptions
          ? "mixing the song and burning captions…"
          : "mixing the song…"
      );
      const finalPath = `${videoPath}.cinematic.webm`;
      temps.push(finalPath);
      await mixAudioAndCaptions({
        ffmpeg: ffmpegPath,
        videoPath: finalBody,
        clips: [],
        offsetsSec: [],
        // Start the song after the title card, not under it.
        music: [{ path: songClip, delaySec: titleOffsetSec, volume: 0.9 }],
        srtPath: burnCaptions ? srtPath : "",
        burnCaptions,
        outPath: finalPath,
        echo,
      });
      const producedSong = await stat(finalPath);
      if (producedSong.size === 0) {
        return notApplied("encoder produced an empty file");
      }
      await rename(finalPath, videoPath);
      // The final video is the original path now; the .srt and lyrics sidecar are
      // deliverables — drop them from the cleanup list.
      temps.splice(temps.indexOf(finalPath), 1);
      if (wroteSrt) {
        temps.splice(temps.indexOf(srtPath), 1);
      }
      temps.splice(temps.indexOf(lyricsPath), 1);
      return { applied: true, titleOffsetSec, stepTimes, notes, meta };
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
    if ("error" in planned) {
      return notApplied(`narration generation failed: ${planned.error}`);
    }
    const { direction, narration, repoDir, base } = planned;

    // Default the title-card background to a local themed gradient when no
    // generated-image provider (Gemini) is configured — network-free and always
    // available, so a plain install still gets an intentional card. The palette
    // follows the resolved theme, so this waits until `direction` is known.
    providers.titleBackground ??= createLocalTitleBackground(
      ffmpegPath,
      direction.category
    );

    // 4. Voice + TTS: one clip per step that got narration text. The provider
    // voices it when available (else macOS `say`). Surface the chosen
    // direction/voice/rate so a delightful run can be reproduced (pin via
    // --prompt and $DAILIES_SAY_VOICE / $DAILIES_SAY_RATE).
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
      videoPath: input,
      narratableSteps,
      clips,
      title: narration.title,
      category: direction.category,
      // Theme only — the narration style ("…as natural prose narration") must
      // not reach the music/title-art providers (it made the score spoken-word).
      directionText: direction.theme,
      providers,
      voiceLabel: speech.label,
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
    const srtGeometry = await probeVideo(ffmpegPath, input);
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
      // The music is timed against the body; shift it past the title card so the
      // score doesn't play over the opening title (clips/captions are already
      // offset by titleOffsetSec).
      music: shiftMusic(music, titleOffsetSec),
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
