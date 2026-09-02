// The LLM plumbing for cinematic scripting: resolving the creative direction and
// change-scale cue, building the narration/lyrics prompts, forcing + parsing the
// structured `claude -p` JSON, and the small pure text helpers those need. The
// plan orchestration (planNarration/planSong) stays in narrate.ts and imports
// what it needs from here.

import type { Logger } from "dailies-logger";
import { type Echo, run, VERSION_PROBE_TIMEOUT_MS } from "./ffmpeg.js";
import { stripOverrideTags } from "./srt.js";
import {
  type StyleId,
  selectStyle,
  selectThemes,
  type ThemeCategory,
} from "./themes.js";

// The LLM call is generous.
const LLM_TIMEOUT_MS = 120_000;

// Flags that strip everything the narration/lyrics calls don't need from the
// `claude -p` context: all MCP servers (their tool schemas can be huge), the
// user's settings/CLAUDE.md/skills, every built-in tool schema, and the
// coding-agent system prompt (replaced with a one-liner — our prompt already
// specifies the full JSON contract). This keeps the logged-in auth token (we do
// NOT use `--bare`, which skips the keychain read and would break auth). The
// model is pinned because `--setting-sources ""` also drops the user's model
// preference, and we don't want the CLI default to silently change output
// quality between environments.
const CLAUDE_MIN_CONTEXT_ARGS: string[] = [
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--setting-sources",
  "",
  "--tools",
  "",
  "--system-prompt",
  "You are a precise generator. Output only what the user's message asks for, with no preamble or commentary.",
  "--model",
  "sonnet",
];

// Max characters of a step's script we feed the LLM — enough for context
// without bloating the prompt.
const SCRIPT_SLICE_CHARS = 200;

interface NarrationStep {
  index: number;
  narration: string;
}

export interface Narration {
  steps: NarrationStep[];
  title: string;
}

// Song-mode plan: one short, singable lyric line per GROUP of steps (consecutive
// short steps are grouped so one verse spans them — see groupStepsForLyrics) plus an
// opening title. Each line is later timed to where it's actually SUNG (the model's
// LRC timestamps and/or whisper word-onsets), and the video is re-timed so each
// group's footage is on screen while its line plays.
interface LyricLine {
  index: number;
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
  title: string;
}

export interface ChangeContext {
  // Stats line for the prompt, e.g. "45 commits, 71 files, +7386/-402".
  label: string;
  // A nudge toward the right production scale for the LLM to match.
  scaleHint: string;
}

// The model — especially through structured output (--json-schema) — often writes
// a two-line title as a LITERAL backslash-n instead of a real newline. Convert it
// to a real newline so wrapTitle splits it into two title-card lines and the
// credits roll collapses it to a space (instead of showing "\n" / a stray "n").
// Pure → unit-tested.
export function normalizeTitle(title: string): string {
  return title.replace(/\\r\\n|\\n|\\r/g, "\n").trim();
}

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

// Build the `claude -p` prompt for SONG mode: themed, singable lyrics ABOUT the
// QA session (the comedic payoff — a checkout flow sung as a power ballad), ONE
// short line per step plus a title. The line count and per-line length are scaled
// to the video so the whole song fits (a short session got only its first line
// sung before — now the lyrics are sized to the runtime). Deterministic given its
// inputs (testable).
export function buildLyricsPrompt(args: {
  direction: string;
  change?: ChangeContext;
  steps: { index: number; name: string; script?: string }[];
  videoSeconds: number;
}): string {
  const { direction, change, steps, videoSeconds } = args;
  const stepCount = Math.max(1, steps.length);
  // Keep every line SHORT and singable — ACE-Step aligns syllables to beats, so a
  // ~6–10-syllable line (one breath) sings cleanly while a long line ("no
  // breathing room") comes out sparse or makes the model loop/hold notes (the
  // official ACE-Step lyric guidance, and the failure mode we saw with long
  // lines). Crucially, the line length does NOT scale with how long a section is
  // on screen: a long section just holds its frame longer; its lyric line stays
  // short. Range kept tight and uniform so successive lines share a rhythm.
  const wordsPerLine = 8;
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
        `Sense of scale (use it only for energy/tone, never to override the genre): the change under review is ${change.label}, so ${change.scaleHint}.`,
        "",
      ]
    : [];

  return [
    "You are writing the lyrics for a short original SONG that scores a screen-recording of an automated browser QA session.",
    "The whole video is set to this one song — there is no spoken narration. Write lyrics that tell the story of the session, fully in character for the creative direction below.",
    "",
    `Creative direction (the song's genre, mood, and voice): ${direction}`,
    "",
    ...changeLines,
    `The video is about ${Math.round(videoSeconds)} seconds long. Write EXACTLY ONE singable lyric line for each section below — ${stepCount} line${stepCount === 1 ? "" : "s"} total, in order — so the song tells the whole story. A section may span a few moments of the session (its steps are joined with →); write one line that covers the whole section.`,
    "Each section (one line of the song lands on each):",
    stepLines,
    "",
    "Rules:",
    `- Write exactly one line per section (${stepCount} total). Each line must be SHORT and singable — about 6–10 syllables, roughly ${wordsPerLine} words or fewer, sung comfortably in ONE breath. This matters: a long, wordy line comes out sparse or makes the singer stumble. Keep the lines' lengths similar so they share a rhythm.`,
    "- Do NOT make a line longer just because its section is long — a longer section simply lingers on screen; its line stays short.",
    '- Use plain, singable words with open vowels. AVOID proper nouns, product/UI names, technical jargon, acronyms, and abbreviations — the singer garbles them. Rephrase the idea in everyday language (e.g. not "the Super Admin approaches the file" but "she steps up to the case").',
    "- Write the words as they should be SUNG: no em-dashes, colons, semicolons, slashes, parentheses, or ellipses inside a line. A comma or nothing is fine; keep punctuation minimal.",
    "- Each line is ABOUT its section (use its intent/what it does), but commit hard to the genre — be playful and vivid, never a dry play-by-play.",
    "- Together the lines should read as one coherent song with a through-line; rhyme or repetition across lines is welcome, but keep the one-line-per-section mapping.",
    "- Do NOT include section tags, chord names, timestamps, or stage directions — just the words to sing for each step.",
    '- Provide a punchy, dramatic, mostly-uppercase "title" for an opening title card. You may use a newline in the title to force a two-line layout.',
    "",
    'Respond with STRICT JSON only — no prose, no markdown fences — exactly: {"title": string, "steps": [{"index": number, "lyric": string}]}',
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
  return { title: normalizeTitle(record.title), steps };
}

// Parse the SONG-mode LLM response into a validated Lyrics, or null on any
// problem. Same lenient JSON handling as parseNarrationJson (strips fences, falls
// back to brace extraction). Shape: {title, steps:[{index, lyric}]} — one sung
// line per step. Empty-text lines are dropped; null only if the whole reply is
// malformed or no usable line survives.
export function parseLyricsJson(raw: string): Lyrics | null {
  const parsed = tryParseJson(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.title !== "string" ||
    record.title.trim() === "" ||
    !Array.isArray(record.steps)
  ) {
    return null;
  }
  const lines: LyricLine[] = [];
  for (const entry of record.steps) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.index !== "number" || typeof e.lyric !== "string") {
      return null;
    }
    const text = e.lyric.trim();
    if (text) {
      lines.push({ index: e.index, text });
    }
  }
  if (lines.length === 0) {
    return null;
  }
  return { title: normalizeTitle(record.title), lines };
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
// Slice the FIRST balanced JSON object out of a string, tracking string/escape
// state so braces inside string values don't miscount. Returns null when there's
// no `{` or the object never closes (a truncated reply). Beats a naive
// firstOpen..lastClose: it survives a model preamble AND trailing prose that
// itself contains braces (which would otherwise drag `lastIndexOf("}")` past the
// real end). Pure → unit-tested.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a character-by-character scanner tracking string/escape/depth state — a state machine that reads worse when split.
function extractBalancedJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

function tryParseJson(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to balanced-object extraction
  }
  const balanced = extractBalancedJson(stripped);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      return null;
    }
  }
  return null;
}

// Resolve the creative direction: the user's verbatim --prompt wins; otherwise
// draw ONE or TWO random themes (per the request — a focused draw the LLM can
// commit to, then adapt to the change's scale) + a weighted style. Returns the
// text injected into the prompt, a short reproducibility label, and the dominant
// theme category (drives the title-card font/color).
//
// In SONG mode the theme stands in for "a random style" (its genre/mood drives
// the music) and the prose/poem/haiku style draw is skipped — the piece is always
// a sung song, so a "render it as a haiku" suffix would just confuse the lyricist
// and the music model.
export function resolveDirection(
  userPrompt: string | undefined,
  opts: { song?: boolean } = {}
): {
  text: string;
  // The clean SUBJECT — the theme label(s) only, without the narration-style
  // directive ("Render it as natural prose narration.") OR the multi-theme blend
  // scaffolding ("commit to X as the dominant voice…"). The music and title-art
  // providers (incl. the Wikimedia keyword search) get this, so they key off the
  // actual themes rather than styling/blend words. Equals `text` for a --prompt
  // (the user's own words are the subject).
  theme: string;
  label: string;
  category?: ThemeCategory;
} {
  if (userPrompt?.trim()) {
    const text = userPrompt.trim();
    return { text, theme: text, label: `prompt: "${text}"` };
  }
  const count = Math.random() < 0.5 ? 1 : 2;
  const drawn = selectThemes(count);
  const themes = drawn.map((theme) => theme.label);
  // `subject` is the clean theme label(s) — what the score and the title imagery
  // (incl. the Wikimedia keyword search) should key off. The blend scaffolding
  // ("commit to X as the dominant voice…") is GUIDANCE for the narration/lyrics
  // LLM only; leaving it in `theme` made an image search hunt for "commit" /
  // "dominant" instead of the actual themes.
  const subject = themes.filter(Boolean).join(", ");
  const blend =
    themes.length === 1
      ? (themes[0] ?? "")
      : `commit to "${themes[0]}" as the dominant voice, optionally borrowing a flourish from "${themes[1]}"`;
  if (opts.song) {
    return {
      text: blend,
      theme: subject,
      label: `theme: ${themes.join(" + ")} · song`,
      category: drawn[0]?.category,
    };
  }
  const style = selectStyle();
  const text = `${blend}. Render it as ${STYLE_DIRECTIVES[style]}`;
  return {
    text,
    theme: subject,
    label: `theme: ${themes.join(" + ")} · style: ${style}`,
    category: drawn[0]?.category,
  };
}

// The branch's review base — its configured upstream (what it'll merge back
// into), NOT a hardcoded "main". Falls back to origin's default branch, then
// "main". Used for both the change-scale cue and the contributor credits so they
// count only this branch's own commits.
export async function resolveBase(repoDir: string): Promise<string> {
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
export async function describeChange(
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

// JSON Schemas passed to `claude --json-schema` to FORCE a conforming reply.
// They mirror what parseNarrationJson / parseLyricsJson validate (title + one
// entry per step/section); parse still runs afterward for the exact checks and
// narration sanitizing.
export const NARRATION_SCHEMA = {
  additionalProperties: false,
  properties: {
    steps: {
      items: {
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          narration: { type: "string" },
        },
        required: ["index", "narration"],
        type: "object",
      },
      type: "array",
    },
    title: { type: "string" },
  },
  required: ["title", "steps"],
  type: "object",
};

export const LYRICS_SCHEMA = {
  additionalProperties: false,
  properties: {
    steps: {
      items: {
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          lyric: { type: "string" },
        },
        required: ["index", "lyric"],
        type: "object",
      },
      type: "array",
    },
    title: { type: "string" },
  },
  required: ["title", "steps"],
  type: "object",
};

// Pull the schema-forced object out of the `--output-format json` envelope. The
// CLI emits a wrapper whose `structured_output` is the already-validated object
// (from the forced tool call) and whose `result` is the same as a JSON string —
// prefer the former, fall back to parsing the latter, then to treating stdout as
// the bare object (older CLI). Returns undefined on an errored/empty envelope.
function extractStructuredOutput(stdout: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return tryParseJson(stdout) ?? undefined;
  }
  if (!envelope || typeof envelope !== "object") {
    return;
  }
  const env = envelope as {
    is_error?: boolean;
    structured_output?: unknown;
    result?: unknown;
  };
  if (env.is_error) {
    return;
  }
  if (env.structured_output !== undefined && env.structured_output !== null) {
    return env.structured_output;
  }
  if (typeof env.result === "string") {
    return tryParseJson(env.result) ?? undefined;
  }
  return;
}

// Run a `claude -p` generation that MUST return an object matching `schema`.
// Passing --json-schema forces the model through a structured-output tool call,
// so it can't emit prose, fences, or a truncated blob — the CLI hands back the
// validated object. We still run `parse` on it for our exact shape + narration
// sanitizing. Returns the value, or a human-readable REASON the caller surfaces
// instead of a bare "generation failed": the claude call's own error, or a
// head+tail description of an unexpected envelope. Retries once (the model is
// stochastic); a CLI error (bad auth/binary/timeout) fails fast. The prompt is
// multi-KB, so echo an elided form.
export async function runClaudeJson<T>(args: {
  label: string;
  prompt: string;
  schema: unknown;
  parse: (raw: string) => T | null;
  log: Logger;
  echo?: Echo;
}): Promise<{ value: T } | { error: string }> {
  const { label, prompt, schema, parse, log, echo } = args;
  const cliArgs = [
    "-p",
    ...CLAUDE_MIN_CONTEXT_ARGS,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    prompt,
  ];
  const MAX_ATTEMPTS = 2; // the model is stochastic — one retry recovers most
  let lastError = `the model returned no usable ${label}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let stdout: string;
    try {
      const retry = attempt > 1 ? `, retry ${attempt}/${MAX_ATTEMPTS}` : "";
      echo?.(
        `$ claude -p --json-schema … <${label} prompt, ${prompt.length} chars${retry}>`
      );
      ({ stdout } = await run("claude", cliArgs, LLM_TIMEOUT_MS));
    } catch (err) {
      // A CLI error (bad auth, missing binary, timeout) is unlikely to fix
      // itself on a retry — fail fast with the tool's own message.
      log.debug({ err }, `cinematic: claude ${label} call failed`);
      const detail = err instanceof Error ? err.message : String(err);
      return { error: `the claude CLI call failed — ${detail}` };
    }
    const output = extractStructuredOutput(stdout);
    if (output !== undefined) {
      const value = parse(JSON.stringify(output));
      if (value) {
        return { value };
      }
    }
    // Schema forcing should make this rare; if it still happens, describe the
    // envelope head+tail so it's diagnosable, then regenerate once.
    log.debug({ stdout, attempt }, `cinematic: could not read ${label} output`);
    lastError = `the model's reply wasn't usable ${label} JSON (${describeReply(stdout)})`;
  }
  return { error: lastError };
}

// A compact description of a reply that failed to parse: its length plus the
// head and (for a long reply) the tail — where truncation or trailing prose
// shows. Pure → unit-tested.
function describeReply(raw: string): string {
  const s = raw.trim();
  if (!s) {
    return "empty output";
  }
  const head = s.slice(0, 140).replace(/\s+/g, " ");
  if (s.length <= 280) {
    return `${s.length} chars — ${head}`;
  }
  const tail = s.slice(-100).replace(/\s+/g, " ");
  return `${s.length} chars — starts: ${head}… ends: …${tail}`;
}
