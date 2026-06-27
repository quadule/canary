// Help prose for the `canary` orchestrator, shown via commander's
// `.addHelpText()` / `.description()`. Mirrors the canary-browser engine's
// rich `--help` (a long-about + an after-help usage guide + per-command detail).
// The sandbox rules, script API, and scripting guide come from
// @usecanary/cli-kit — the single source of truth shared with canary-browser —
// so `canary --help` is fully self-contained for writing step scripts even
// when the engine CLI is not installed.
import {
  buildScriptingGuide,
  indent,
  RULE_DATA_PASSING,
  RULE_FAIL_FAST,
  RULE_SCREENSHOT,
  sandboxReference,
  sessionExample,
} from "@usecanary/cli-kit";

// Shown at the top of `canary --help`.
export const CLI_LONG_ABOUT = `Canary records capture-enabled QA sessions. It drives a real browser with
scripts run as ordered steps, captures a Playwright trace, video, network HAR,
and console for each run, and renders a self-contained report.html you can open
or browse in a local web UI. A background daemon (Playwright + a QuickJS sandbox)
starts automatically when needed.

THE SESSION LIFECYCLE:
  1. start   canary session start --name "checkout"        -> prints a session id
  2. run     canary run step.js --session <id> --step open    (one script per step)
  3. end     canary session end <id>                        -> writes report.html
  4. view    canary ui                                      -> browse every session

WHAT IS CAPTURED (per session; toggle on \`session start\`):
  trace        Playwright trace — DOM snapshots + actions, one group per step
  video        WebM recording of the run
  har          network request/response log
  console      console output + page errors
  screenshots  one per step, auto-captured from the step's last-opened page

Artifacts live under ~/.canary/sessions/<id>/ (session.json, results.json, report.html, trace.zip, …).
Scripts run in a QuickJS sandbox (not Node.js) with a pre-connected \`browser\` global — the API
reference follows; \`canary run --help\` has the scripting guide and worked examples.

${sandboxReference()}`;

// Shown after the options in `canary --help`. The screenshot rule, data
// passing, and step discipline come from the shared doc snippets so this help
// cannot drift from the skills/REFERENCE.md versions of the same rules.
export const USAGE_GUIDE = `SESSION WORKFLOW GUIDE:
  Structure a session as a sequence of small steps — one script per step (open, act, assert).
  Each \`canary run --step <name>\` is one step in the report, with its own trace group and ONE
  auto-captured screenshot.

${indent(RULE_SCREENSHOT, "  ")}

  Passing data between steps:
${indent(RULE_DATA_PASSING, "    ")}

  Reading results:
    canary session list                       List sessions (table; --json for machine output)
    canary status --session <id>              One session's status
    open ~/.canary/sessions/<id>/report.html  The self-contained report
    canary ui                                 Browse, search, and organize all sessions

  Step discipline:
${indent(RULE_FAIL_FAST, "    ")}

  Tips:
    - \`--json\` (global) emits machine-readable JSON on stdout; \`-v\`/\`--verbose\` raises stderr logging.
    - \`canary session end --stop-daemon\` shuts the daemon down if nothing else is using it.
    - Need a quick one-off with NO recording? Use \`canary-browser run\` instead of a session.
    - Writing step scripts? \`canary run --help\` has the full SCRIPTING GUIDE — snapshotForAI, humanClick/humanFill, waiting patterns, and worked examples.`;

// Per-command long help (shown before that command's own --help body).
export const SESSION_START_LONG_ABOUT = `Start a capture-enabled session and print its id.

Capture is on by default — disable per stream with --no-trace / --no-video / --no-har / --no-console.
Use --headless for unattended runs; omit it to watch the browser window.
The page records at a fixed 1280x720 desktop viewport — override with --viewport WxH.
A virtual cursor + click animation is drawn into the recording so interactions are visible
in video and screenshots; disable it with --no-cursor.
Planning a cinematic edit? Pass --cinematic so page.showCaption overlays are suppressed (their
text still feeds the narration) and won't double up with the captions burned in by
\`session end --cinematic\`.

  id=$(canary session start --name "checkout")
  id=$(canary session start --name "smoke" --headless --no-video)
  id=$(canary session start --name "demo" --cinematic)`;

export const RUN_LONG_ABOUT = `Run a script as one step inside a session.

The script (a FILE, or stdin if omitted) executes as top-level JavaScript with \`await\` in a
sandboxed QuickJS runtime — full reference below. The step's name labels it in the report and
owns ONE auto-captured screenshot (taken from the LAST page opened during the step). Named
pages persist across steps within the session, so each step picks up where the last left off;
pass values between steps with writeFile/readFile.

${sandboxReference()}

Examples:
  canary run open.js --session "$id" --step open
  echo 'const p = await browser.getPage("home"); await p.goto("https://example.com");' \\
    | canary run --session "$id" --step home --timeout 30`;

// The scripting guide — best practices + worked examples in canary's own
// invocation style — shown after `canary run --help`, where step scripts are
// actually written. Kept off the top-level `canary --help` to keep it scannable;
// the top level points here instead.
export const RUN_SCRIPTING_GUIDE = buildScriptingGuide({
  example: sessionExample,
  heading: "SCRIPTING GUIDE:",
});

export const SESSION_END_LONG_ABOUT = `Stop recording, collect artifacts, and render the report.

Writes ~/.canary/sessions/<id>/report.html (self-contained) plus results.json. Pass --stop-daemon to
shut the daemon down afterward if no other sessions or browsers remain.

Videos are condensed when ffmpeg is available (PATH, $CANARY_FFMPEG, or Playwright's bundled
copy): the pre-page-load segment is dropped and motionless stretches are trimmed out with a
frame-accurate re-encode that keeps real motion (cursor, typing, captions). Pass --no-condense
to keep the raw recordings.

CINEMATIC MODE (--cinematic): turn the silent recording into a narrated short.
An LLM writes themed narration per step, a voice reads it, and each step's frame is held just
long enough for its line; an opening title card and burned-in captions are added, plus a sibling
.srt. Requires the 'claude' CLI; voicing uses a local oMLX TTS model if available, else macOS
'say', else a Gemini key (so it can run off macOS with oMLX or a key). The title card needs an
ffmpeg built with drawtext and burned captions need the subtitles filter (otherwise it writes a
soft-sub .srt and tells you). Every generation command (say/ffmpeg/claude, and a redacted curl
for HTTP TTS) is printed so a run is easy to reproduce and tweak.

SONG MODE (--song): score the whole video with ONE original song instead of spoken narration.
An LLM writes ONE short, singable lyric line PER STEP and a music model sings them. Like narration,
each step's frame is held for a readable beat (re-timing) so the body outlasts the song's short
instrumental intro and the vocals play across it; an opening title card and credits are added. Each
lyric line is burned in as a caption at its step (and a sibling .lyrics.txt + .srt are written) —
the sung vocals aren't frame-aligned to the captions (the model paces them), so the captions track
the on-screen steps. Use --no-captions to skip the burn. Needs the 'claude' CLI plus a lyrics-capable
music model: the local ACE-Step server (see $CANARY_ACESTEP_URL) or a Gemini key (Lyria). Combine
with --prompt to steer the genre.

  --song              score the video with a sung song instead of narration (implies --cinematic)
  --prompt "<text>"   steer theme/tone/style in your own words (implies --cinematic);
                      omit for a random theme. e.g. --prompt "noir detective, as a haiku"
                      Re-run --cinematic with a new --prompt anytime: the pre-cinematic cut is
                      preserved beside the video, so a re-theme is fast and needs no re-recording.
  --no-captions       skip burning subtitles into the video (the .srt is still written)
  $CANARY_SAY_VOICE / $CANARY_SAY_RATE   pin the voice / words-per-minute
  $CANARY_SAY_COMMAND   replace 'say' with your own TTS command (run via the shell, so it may
                        include args). It receives the text to speak as its only argument and must
                        write audio to $CANARY_SAY_OUTPUT; $CANARY_SAY_VOICE is passed in the
                        environment. Use it for a non-macOS tool, or a wrapper that voices a macOS
                        Personal Voice (e.g. DYLD_INSERT_LIBRARIES=…/mysay.dylib say -v
                        "$CANARY_SAY_VOICE" -o "$CANARY_SAY_OUTPUT" "$1")
  $CANARY_OMLX_URL / $CANARY_OMLX_API_KEY / $CANARY_OMLX_TTS_MODEL   use a local oMLX server for
                        TTS (narration stays on your machine); key also read from ~/.omlx
  $CANARY_ARCHIVE_MUSIC=1   score the video with free Creative-Commons music from archive.org
                        (attribution is added to the run notes); needs ffmpeg, no model download
  $CANARY_ACESTEP_URL / $CANARY_ACESTEP_API_KEY / $CANARY_ACESTEP_MODEL   point at a local ACE-Step
                        server for generated music (the bed, and the sung song in --song mode)

  canary session end "$id"
  canary session end "$id" --cinematic
  canary session end "$id" --song
  canary session end "$id" --song --prompt "80s power ballad"`;

export const STOP_LONG_ABOUT = `Stop the background daemon and everything it is running (all browsers and sessions).

This is the same graceful shutdown as \`canary daemon stop\`. Any still-active session is
aborted — its artifacts are flushed, but its report.html is NOT regenerated. For a clean
report, run \`canary session end <id>\` first, then \`canary stop\`.

  canary stop`;

export const UI_LONG_ABOUT = `Launch the local web UI to browse, organize, and search recorded sessions.

Spins up a local server (like \`npx playwright show-trace\`) and opens your browser. Reads
~/.canary/sessions by default; point it elsewhere with --dir. Ctrl-C stops it.

  canary ui
  canary ui --dir ./artifacts --no-open`;

export const INSTALL_LONG_ABOUT = `Install the embedded daemon runtime: Chromium plus the Playwright + QuickJS
sandbox, into ~/.canary. Run once before your first session (downloads ~150 MB).`;

export const INIT_LONG_ABOUT = `One-shot setup: install the browser runtime, then print next steps (add the
agent plugin, install skills, open the viewer). The friendlier Ink version is \`npm create canary\`.`;
