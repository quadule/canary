// Decide whether — and how — to record a demo for a pull request, for the
// nightly demo workflow (.github/workflows/dailies-demo.yml).
//
// Two layers, so a repo configures once and a PR only says what's different:
//
//   .dailies/config.json   repo defaults — the target url, which changed paths
//                          are worth demoing, the default cinematic direction
//   the PR body            per-PR overrides (below)
//
// PR-body conventions (case-insensitive, value runs to end of line):
//   dailies-url: / dailies-target: / Demo URL: / Demo target:   → the app to drive
//   dailies-theme: / dailies-prompt: / Theme:                   → cinematic direction
//   "plain demo" / "no cinematic" / "plain video" / "no narration" → disable cinematic
// With no explicit target marker the first standalone http(s) URL in the body is
// used, then the repo default.
//
// Kept as pure, unit-tested functions with a thin JSON CLI — bash `grep` in a
// YAML `run:` block is where this kind of logic rots.

import { readFile } from "node:fs/promises";
import {
  type DemoVerdict,
  isWorthDemoing,
  loadProject,
  type ProjectConfig,
} from "../project/config.js";

// The commit each existing demo comment was recorded at, newest last.
//
// The workflow stamps `<!-- dailies-demo: <sha> -->` into its own PR comment so a
// later run can tell whether the PR has moved since its last demo. An HTML
// comment keeps it invisible in the rendered comment, and reading it back needs
// no state outside the PR itself.
export function demoedShas(comments: string[]): string[] {
  const re = /<!--\s*dailies-demo:\s*([0-9a-f]{7,40})\s*-->/i;
  return comments
    .map((c) => c.match(re)?.[1])
    .filter((sha): sha is string => Boolean(sha));
}

// Whether this PR head has already been demoed. Compared by prefix so a short
// sha in a comment still matches the full head sha (and vice versa). Pure →
// unit-tested.
export function isAlreadyDemoed(headSha: string, comments: string[]): boolean {
  const head = headSha.trim().toLowerCase();
  if (!head) {
    return false;
  }
  return demoedShas(comments).some((sha) => {
    const s = sha.toLowerCase();
    return head.startsWith(s) || s.startsWith(head);
  });
}

export interface DemoRequest {
  // Produce the cinematic cut (narration/title/captions) vs a plain recording.
  cinematic: boolean;
  // Verbatim cinematic direction for `session end --prompt`, or null for a
  // random theme.
  prompt: string | null;
  // The running app to drive. Null → nothing to record against.
  target: string | null;
}

export interface DemoDecision extends DemoRequest {
  // One line explaining the decision, for the workflow log and the PR comment.
  reason: string;
  // Whether to actually record.
  run: boolean;
}

const TARGET_MARKERS = [
  "dailies-url",
  "dailies-target",
  "demo url",
  "demo target",
];
const THEME_MARKERS = ["dailies-theme", "dailies-prompt", "theme"];
const PLAIN_RE = /\b(plain demo|no cinematic|plain video|no narration)\b/i;
// A demo target can be a remote URL, a file:// URL, or a local .html path (so a
// static HTML file checked into the repo works as a target too).
const URL_RE = /(?:https?|file):\/\/[^\s<>()[\]]+/i;
const HTML_PATH_RE = /[^\s<>()[\]]+\.html?(?=[\s)>.,;]|$)/i;
const TARGET_RE = new RegExp(`${URL_RE.source}|${HTML_PATH_RE.source}`, "i");

// A target is valid if it's an http(s)/file URL or a path to an .html/.htm file.
function isValidTarget(value: string): boolean {
  return /^(?:https?|file):\/\//i.test(value) || /\.html?$/i.test(value);
}

// Value of the first `marker: value` line (case-insensitive), trimmed, or null.
function markerValue(body: string, markers: string[]): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z][a-z0-9 _-]*?)\s*:\s*(.+?)\s*$/i);
    if (!(match?.[1] && match[2])) {
      continue;
    }
    if (markers.includes(match[1].trim().toLowerCase())) {
      return match[2].trim();
    }
  }
  return null;
}

// Strip wrapping <…> / trailing sentence punctuation a URL often picks up in prose.
function cleanUrl(url: string): string {
  return url.replace(/^[<(]+/, "").replace(/[>).,;]+$/, "");
}

// Read just the per-PR overrides out of a body. Pure → unit-tested.
export function parseDemoRequest(body: string): DemoRequest {
  const text = body ?? "";
  const marked = markerValue(text, TARGET_MARKERS);
  const candidate = marked
    ? cleanUrl(marked)
    : (text.match(TARGET_RE)?.[0] ?? null);
  const target = candidate ? cleanUrl(candidate) : null;
  return {
    cinematic: !PLAIN_RE.test(text),
    prompt: markerValue(text, THEME_MARKERS),
    target: target && isValidTarget(target) ? target : null,
  };
}

// Combine repo defaults, the PR body, and the change set into one decision.
// The PR body wins over repo defaults for every field it specifies; the change
// set only ever decides whether to run at all. Pure → unit-tested.
export function decideDemo(args: {
  body: string;
  changedPaths: string[];
  // Existing PR comments, for the "already demoed this commit" check.
  comments?: string[];
  config: ProjectConfig;
  // The PR head this run would demo.
  headSha?: string;
}): DemoDecision {
  const { body, changedPaths, comments = [], config, headSha = "" } = args;
  const override = parseDemoRequest(body);
  const target = override.target ?? config.url;
  // `cinematic` is a flag, so "specified" means the body opted out explicitly.
  const cinematic =
    override.cinematic === false ? false : config.demo.cinematic;
  const prompt = override.prompt ?? config.demo.prompt;
  const worth: DemoVerdict = isWorthDemoing(changedPaths, config.demo.paths);

  // Nothing new to show: this exact commit already has a demo. Checked before
  // the target, so a re-run of an already-demoed PR is quiet rather than
  // complaining about configuration.
  if (isAlreadyDemoed(headSha, comments)) {
    return {
      cinematic,
      prompt,
      reason: `already demoed at ${headSha.slice(0, 7)}`,
      run: false,
      target,
    };
  }

  if (!target) {
    return {
      cinematic,
      prompt,
      reason:
        "no demo target — set `url` in .dailies/config.json or add `dailies-url: <url>` to the PR body",
      run: false,
      target: null,
    };
  }
  return { cinematic, prompt, reason: worth.reason, run: worth.worth, target };
}

// CLI: `tsx demo-request.ts --head-sha <sha> [--body-file <p>]
// [--changed-file <p>] [--comments-file <p>] [--cwd <dir>]` → JSON on stdout.
//
// The bulky, arbitrary inputs come from FILES, not argv or env. PR bodies and
// comments can contain anything — newlines, quotes, NUL bytes — and a shell
// cannot carry that through `$(...)` (command substitution truncates at a NUL),
// while argv and env are both visible in the process table. `--comments-file`
// is a JSON array of comment bodies, exactly what `gh pr view --json comments`
// produces; `--changed-file` is one path per line, as `gh pr diff --name-only`
// produces.
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag?.startsWith("--")) {
      out[flag.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return out;
}

async function readOrEmpty(file: string | undefined): Promise<string> {
  if (!file) {
    return "";
  }
  try {
    return await readFile(file, "utf8");
  } catch {
    // A missing input file means "nothing here" — never a failed run.
    return "";
  }
}

// A JSON array of comment bodies; anything else yields no comments, which fails
// OPEN (the PR gets demoed again) rather than silently suppressing a demo.
function parseComments(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [body, changed, comments] = await Promise.all([
    readOrEmpty(args["body-file"]),
    readOrEmpty(args["changed-file"]),
    readOrEmpty(args["comments-file"]),
  ]);
  const { config } = await loadProject(args.cwd ?? process.cwd());
  const decision = decideDemo({
    body,
    changedPaths: changed.split(/\r?\n/),
    comments: parseComments(comments),
    config,
    headSha: args["head-sha"] ?? "",
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

// Run main only when invoked directly (not when imported by the test).
if (process.argv[1]?.endsWith("demo-request.ts")) {
  await main();
}
