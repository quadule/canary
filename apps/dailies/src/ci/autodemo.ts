// Parse an `autodemo` request out of a pull-request body for the GitHub Actions
// demo pipeline (.github/workflows/autodemo.yml). Kept as a pure, unit-tested
// function — bash `grep` in YAML is where this kind of logic rots — with a thin
// CLI wrapper the workflow invokes via tsx to get JSON.
//
// PR-body conventions (all case-insensitive, value runs to end of line):
//   autodemo-url: / autodemo-target: / Demo URL: / Demo target:   → the app to drive
//   autodemo-theme: / autodemo-prompt: / Theme:                    → cinematic direction
//   "plain demo" / "no cinematic" / "plain video" / "no narration" → disable cinematic
// If no explicit target marker is present, the first standalone http(s) URL is used.

export interface AutodemoRequest {
  // Whether to produce the cinematic cut (narration/title/captions) vs a plain
  // recording. Default true unless the body opts out.
  cinematic: boolean;
  // Verbatim cinematic direction (theme/tone/style) for `session end --prompt`,
  // or null to let the pipeline pick a random theme.
  prompt: string | null;
  // The running app the demo records against. Null → the workflow no-ops with a
  // comment asking for one (a PR has no inherent target).
  target: string | null;
}

const TARGET_MARKERS = [
  "autodemo-url",
  "autodemo-target",
  "demo url",
  "demo target",
];
const THEME_MARKERS = ["autodemo-theme", "autodemo-prompt", "theme"];
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

export function parseAutodemoRequest(body: string): AutodemoRequest {
  const text = body ?? "";
  const marked = markerValue(text, TARGET_MARKERS);
  const candidate = marked
    ? cleanUrl(marked)
    : (text.match(TARGET_RE)?.[0] ?? null);
  const target = candidate ? cleanUrl(candidate) : null;
  return {
    target: target && isValidTarget(target) ? target : null,
    cinematic: !PLAIN_RE.test(text),
    prompt: markerValue(text, THEME_MARKERS),
  };
}

// CLI: `tsx autodemo.ts "<pr body>"` → JSON on stdout (the workflow consumes it).
// Reading argv keeps the body out of the process env / logs.
function main(): void {
  const body = process.argv[2] ?? "";
  process.stdout.write(`${JSON.stringify(parseAutodemoRequest(body))}\n`);
}

// Run main only when invoked directly (not when imported by the test).
if (process.argv[1]?.endsWith("autodemo.ts")) {
  main();
}
