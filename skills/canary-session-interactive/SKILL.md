---
name: canary-session-interactive
description: Record a Canary QA session collaboratively, in the main conversation — the agent drives autonomously but pauses to ask you for direction when unsure, and can hand you the live browser to do steps it can't (log in, flip a feature flag, change settings), capturing your actions as recorded steps. Use when a flow needs your input or manual setup mid-run. Trigger phrases — "record this with me", "interactive session", "I'll need to take over", "let me do part of it", "ask me if you get stuck".
allowed-tools:
  - Bash(canary:*)
  - Bash(canary-browser:*)
  - Bash(npx @usecanary/cli:*)
  - Bash(npx @usecanary/browser:*)
  - Bash(npx @usecanary/ui:*)
license: MIT
metadata:
  author: usecanary
  version: 0.4.4
  category: workflow
  tags:
    - canary
    - qa
    - testing
    - interactive
---

# Canary session (interactive)

Same recorded QA session as **canary-session** — explore a flow step by step against one
persistent headed browser; trace / video / HAR / console are captured and rendered into
`report.html` — but run **in this conversation, not a subagent**, so you and the user collaborate
as it records.

## Start here — read before your first command

<!-- canary:snippet rule-start-here cli=npx-cli -->
- STOP — before your FIRST `npx @usecanary/cli` command (not just before writing a script), read the
  **canary-scripting** skill in full: invoke the canary-scripting skill (in this repo you can also
  open `skills/canary-scripting/SKILL.md`). It holds the script API and the interaction rules the
  rest of this skill relies on. Don't start a session without it.
- Follow the workflow's commands as written — don't run `--help` just to explore. Only when you
  need a specific flag and aren't sure of it, check `npx @usecanary/cli <command> --help` instead of guessing.
- Drive every recorded click and text entry with `page.humanClick` / `page.humanFill`, never raw
  `click` / `fill`. This is not optional.
- Reach a page by clicking the control a real user sees (e.g. the login button on the main login
  page), not by brute-forcing a hidden widget. If a step times out, STOP and take the obvious path
  instead of retrying the same dead end — and use `--timeout 10` so a wrong turn fails fast instead
  of burning 30s.
- A click that navigates (Turbo / SPA especially) finishes asynchronously — `humanClick` returns
  BEFORE the navigation commits, so do NOT read `page.url()` or `snapshotForAI()` on the next line
  (you'll get the OLD page; `page.url()` is also client-cached and lags a Turbo nav). Two correct
  options: (1) make the navigating click the LAST action of the step and observe at the start of the
  next — Canary settles the page at each step boundary, so it's already on the committed destination;
  or (2) to stay in the same step, `const href = await page.humanClickAndWaitForURL(link)`. To check
  where you landed between steps without a recorded run, `npx @usecanary/cli session url <id>` prints the live
  committed URL (read-only, fast).
- A click returning is NOT success. Before you submit, confirm the submit control is enabled and
  every required field / checkbox is satisfied; afterward, verify the change actually persisted. A
  disabled or validation-blocked submit saved nothing — never report that run as passed.
<!-- canary:end rule-start-here -->

<!-- canary:snippet rule-drive-with-canary cli=npx-cli -->
- Drive the browser only through Canary — the `npx @usecanary/cli` CLI and the scripts it runs. Do NOT use
  Claude in Chrome, a computer-use / screenshot tool, or any other browser automation to navigate,
  click, fill, or read a page, even for a single step. Those bypass Canary's sandbox, the on-screen
  cursor, and the trace / video / HAR capture, so nothing is recorded or verifiable. If a step
  tempts you toward another browser tool, write a Canary script instead.
<!-- canary:end rule-drive-with-canary -->

<!-- canary:snippet rule-test-as-user -->
- Drive the real user flow in the browser FIRST. Do NOT change the environment to set up or "fix" a
  precondition before you've tried the flow as a user — no Rails/DB console, env vars, feature-flag
  flips, seed scripts, or API calls to manufacture state. The thing you were asked to verify is
  sacred: never reset, clear, bypass, or fake it. (Asked to show a Terms-of-Service prompt appears?
  Do NOT clear the user's ToS acceptance — that prompt IS the point, and the environment was likely
  prepared so it shows.) Reading the code or inspecting state to understand the flow is fine, but
  only AFTER you've attempted to drive it from the browser, and strictly read-only — never mutate.
- Weigh what you were asked. Verifying a change or feature → be conservative: the setup IS the test,
  so touch nothing and drive exactly what a real user would. Only performing or recording a workflow
  (no pass/fail claim) → more leeway to arrange incidental preconditions, but still drive as a real
  user and never mutate what the run is meant to show.
<!-- canary:end rule-test-as-user -->

<!-- canary:snippet rule-scripting-reference cli=npx-cli -->
- The canary-scripting skill is the full scripting reference — the custom page and locator API, the
  observe-first and human-interaction rules, and the sandbox limits. Load it and read it in full
  before your first command — not just before writing a script (a `session start` counts).
- Need a specific flag and aren't sure of it? Check `npx @usecanary/cli <command> --help` rather than guessing
  — but don't run `--help` routinely or to explore; the skills already give you the commands. And
  --help only covers syntax: it omits the agent rules (observe-first, the human-interaction helpers,
  pass/fail), so read the canary-scripting skill for those.
<!-- canary:end rule-scripting-reference -->

The difference from the autonomous flow is just *who decides*:

- **Autonomous by default.** Drive the flow yourself, step by step, exactly as in canary-session.
- **Ask, don't guess.** When the next move is genuinely ambiguous (which of two paths, an
  unexpected screen, a destructive action, missing data), STOP and ask the user in chat instead of
  guessing. You're in the main thread — a question is cheap.
- **Hand over when you can't.** Some steps aren't yours to do: logging in with the user's
  credentials, flipping a feature flag, changing company settings, dismissing a one-time dialog,
  anything off the happy path. Don't manufacture the precondition yourself (no console / DB / API) —
  hand the user the live browser, let them do it, and capture what they did as a recorded step (see
  *Manual takeover*). Or just ask: they may have set it up for you already.

## When to use

- A flow needs the user's input or manual setup partway through ("before this link shows up I need
  to enable the flag and update settings").
- The user wants to be asked rather than have the agent guess.
- The user wants to drive part of the flow themselves while it's recorded.

For a hands-off run that just produces a report, use **canary-session** (the subagent). For a
one-off scrape with no recording, use **canary-automate**.

## Manual takeover (capture the user's own actions)

The browser is headed, so the user can drive it directly. YOU run the takeover commands yourself
(plain Bash) — the user never runs a command; they only act in the browser window and tell you in
chat when they're done. To capture what they do as a clean, replayable step:

1. **Start the takeover (you run this):** `npx @usecanary/cli session takeover "$id" --step
   <intent-name>`. This enables Playwright's recorder on the live context.
2. **Ask the user to take over** and to just tell you when they're done ("continue" / "done"). They
   click / type / navigate in the already-open browser window; the virtual cursor hides while they
   drive. Wait — don't run steps meanwhile (the session rejects them mid-takeover).
3. **The moment they say to continue, run the stop yourself:** `npx @usecanary/cli session takeover
   "$id" --stop` (plain Bash). Their "continue" IS the signal — never ask the user to run a command.
   The recorder turns their actions into generated Playwright source, prints it, and records it as
   the step (`--cancel` instead to discard). Read the printed code, then carry on driving.

The user's actions are in the video/trace either way; `--stop` additionally preserves the generated
Playwright code as the step's source (a clean record, and what a later Playwright→RSpec step would
build on). Read the printed code, then continue driving the flow.

## Workflow

1. Runtime: if `canary` (or `npx @usecanary/cli`) already runs, it's installed — don't reinstall.
   Only run `npx @usecanary/cli install` if a command reports the runtime/browser is missing.
2. Start: `id=$(npx @usecanary/cli session start --name "<flow>")`. The browser is headed by
   default (no flag) — which is required here so the user can take over; never pass `--headed` (it
   doesn't exist), and don't pass `--headless`.
3. **LOOK** — observe before acting; an observe step records like any other (log `page.url()`,
   `page.title()`, `(await page.snapshotForAI()).full`).
4. **DECIDE** the next small action. If it's ambiguous or not yours to do, ask the user / hand over.
5. **ACT** — run that action as an intent-named step (`npx @usecanary/cli run --session "$id" --step
   <name>`), or take over (above) when the user must do it.
6. **READ** stdout + exit code; on failure observe and retry as a new step.
7. Loop 3–6 until done; finish with explicit assertion step(s) logging `PASS`/`FAIL`.
8. End, render, and open the report: `npx @usecanary/cli session end "$id" --open`. The `--open`
   flag opens the self-contained `~/.canary/sessions/<id>/report.html` in the browser for you —
   always pass it here. (If the host has no opener and nothing appears, open the printed path
   yourself.) Then mention **canary-review** / `npx @usecanary/ui` to browse all sessions.

## Hard rules

<!-- canary:snippet rule-observe-first -->
- Unknown page? Snapshot first, then act: read `(await page.snapshotForAI()).full` to see the full
  page, including content below the fold and near the end. Pick a semantic selector from it
  (`getByRole`, `getByText`), then interact. Never guess selectors blind, and don't start with a
  shallow or truncated observation.
- Known page or selectors? Skip the snapshot and use direct selectors — faster and more reliable.
- The snapshot covers the whole page no matter where it's scrolled — never add a scroll step just to
  observe. If the full snapshot is overwhelmingly large or mostly repeated nav/sidebar chrome,
  re-observe with a deliberate scope such as `{ selector: "main" }`, an active dialog, or the
  relevant form. After an interaction, pass `{ track: "main" }` to get just what changed instead of
  re-reading the full outline.
- On a long or dynamic form, enumerate EVERY required field in ONE pass up front, before you fill
  anything — don't discover requirements one submit-failure at a time. Requirements appear in the
  snapshot as an asterisk or "required" / "This field is required" in a field's accessible name;
  confirm with a single DOM sweep, e.g. `page.$$eval("[required], [aria-required='true']", els =>
  els.map(e => e.name || e.id))`. Build the checklist, fill all of it, THEN submit. Dynamic forms
  grow — choosing an option (employment type, a guild) can rebuild the form and reveal a NEW required
  section, so re-enumerate after any interaction that rebuilds it.
- After a navigation the new page often renders asynchronously (client-side routing / SPAs swap
  content without a full document load). Don't snapshot or assert the instant a click returns.
  Prefer acting on or waiting for a KNOWN element on the destination (`getByRole`/`getByText`) —
  Playwright auto-waits for it, which both confirms the navigation and avoids reading stale content.
  Need the result in the SAME step after a click that navigates? `await
  page.humanClickAndWaitForURL(link)` waits for the URL and load in one call. Otherwise you needn't
  wait at all: Canary settles the page (load + network-idle + DOM quiescence) at the END of every
  step, so just end the step and observe at the start of the next — its fresh page is already on the
  committed, quiet destination. Avoid fixed `waitForTimeout`; `waitForLoadState("load")` /
  `"domcontentloaded"` are fine, but `"networkidle"` can hang on apps with long-lived HTTP (SSE,
  long-polling, heartbeats) — an open WebSocket alone does NOT block it.
- `page.url()` is a cached value updated by an async event, so right after a client-side navigation
  it can still read the OLD url — especially a Turbo/SPA visit, whose URL only changes once its fetch
  lands and the nav commits (the NEXT step's fresh page reads it correctly — the step-end settle
  guarantees that). To get the post-nav URL WITHIN a step, use the helpers that read the live
  `location.href`: `page.humanClickAndWaitForURL(link)` (returns the new href) or
  `page.waitForURLChange({ from })`; or `page.waitForURL(<url|regex|fn>)` for a known destination; or
  read it directly with `await page.evaluate(() => location.href)`.
<!-- canary:end rule-observe-first -->

<!-- canary:snippet rule-visible-interaction -->
- Every recorded click and text entry goes through the human helpers
  `page.humanClick(target)` / `page.humanFill(target, text)` (`target` is a selector string or a
  locator) — this is the default, not an option. Do NOT use raw `page.click` / `locator.click` /
  `page.fill` for a recorded action. The helpers reveal the element (scroll it into view), glide
  the on-screen cursor onto it and let it settle, then act through real input — a true click, and
  for fills a focus-then-type that sends real key events. That cursor-settling beat is the point:
  a bare `locator.click()` moves and presses in the same instant, so on camera the click lands
  before the cursor has visibly arrived. (Gestures the helpers don't cover — `hover`, keyboard
  `press`, `selectOption`, drag — use the normal locator methods, still on a revealed element.)
- ALWAYS reveal an element before interacting — no exceptions; the recording must show every
  interaction a viewer is asked to trust. The helpers scroll to the target but cannot reveal an
  element hidden behind collapsed UI — if
  it lives inside a closed menu, dropdown, accordion, tab, or unopened modal, open that container
  first, then interact — in the SAME step. A toggle-opened container (a menu/dropdown) STAYS open
  across steps, so if you opened it in an earlier step (e.g. to snapshot and find the item), do NOT
  click the toggle again to "open" it — that CLOSES it; just click the item. Any
  `scrollIntoViewIfNeeded` / `page.isVisible(sel)` checks fold into the interaction's own script —
  keep them out of the step list as bookkeeping.
- To bring something into view just to SHOW it (not act on it), use `page.reveal(target)` — never
  `window.scrollTo` or `page.evaluate(() => scrollTo(...))`, which move nothing the camera can see.
  Observing doesn't need scrolling at all: `snapshotForAI` reads the whole page regardless of scroll.
- Toggle a checkbox or radio with `humanClick` — target it by role/name
  (`getByRole("checkbox", { name })`) or its label text. Apps routinely hide the real `<input>` and
  draw a custom control with CSS, so the input is zero-size and a direct click misses; `humanClick`
  detects that and clicks the input's `<label>` for you (what a real user clicks). You don't need
  to find the label yourself — just don't reach past `humanClick` to a raw `click` on the input.
- Before interacting, make sure the target isn't covered by an overlay or modal — a cookie
  banner, dialog, toast, or loading spinner. A click that fails with "intercepts pointer events" /
  "not clickable" means something is on top: deal with that overlay first (act within the modal,
  accept/close the banner, wait for the spinner to clear), then retry — don't `{ force: true }`
  through it. Right after a navigation, check for such overlays before starting the main flow.
- When several `<dialog>` elements coexist in the DOM at once (a modal, a drawer, …), don't rely
  on `isVisible()` / `isHidden()` to pick the active one — frameworks often show/hide a `<dialog>`
  with CSS while it stays `open` in the DOM, so Playwright's visibility heuristic can report the
  truly-shown one as `false`. Identify it by content instead: `page.locator("dialog", { hasText:
  "…" })` / `page.getByRole("dialog", { name: "…" })`, or scope straight to a known descendant
  inside it — rather than testing `.isVisible()` across every match and trusting the boolean.
- Cascading-disclosure UI — a menu / split button that opens a list of item buttons, each of which
  opens something more — does NOT tell you in advance whether an item reveals an INLINE section
  grafted into the page or a drawer/modal, and that can differ per item and change between releases.
  So after EACH click in the chain, observe immediately — prefer `snapshotForAI({ track: "main" })`
  so an empty diff instantly tells you the click did nothing (wrong element, or a menu item whose
  menu had already closed) versus showing you exactly what appeared. Don't pre-commit to hunting a
  `<dialog>`: a `dialog`-scoped snapshot after an inline disclosure finds nothing and sends you
  chasing a modal that never opened. The reveal may need a beat to mount or animate, so then wait on
  the concrete new element you expect (`getByRole`/`getByText` for its heading or first field), not a
  fixed sleep.
- Move between pages the way a user does: click links and buttons, don't `goto` internal URLs.
  The lone exception is the flow's entry point — the first navigation is a `page.goto(...)`;
  after that, reach each new page by clicking your way there.
- Find elements the way a user reads them — `getByRole(role, { name })`, `getByText`,
  `getByLabel`. CSS selectors and `page.evaluate(...)` are fine for EXAMINING the page, but when
  a selector is unavoidable in a recorded action prefer a `data-testid` / `data-test-id`
  attribute; never hardcode presentational class names.
- Never bypass real input: no `{ force: true }`, no `page.evaluate(el => el.click())`, and for a
  field the user types into don't set the value with the atomic `page.fill` (it writes in one
  step with no typing on camera — that's why `humanFill` types key by key instead). If a real
  user couldn't see and perform the interaction, the run hasn't verified anything and the video
  shows nothing.
- Don't submit the instant you finish an interaction — this applies to EVERY input before a
  submit, not just typing: checking a box, choosing a radio, selecting a dropdown option, and
  filling a field all commonly trigger async work — inline validation, a newly revealed or
  required field, a dependent control, the submit button enabling/disabling. After each such
  interaction wait on the CONCRETE result before moving on — assert or act on the thing that
  changed (the validation message appearing, the new/required field rendering, the submit button
  flipping enabled); Playwright auto-waits when you act on it. Re-check the submit control is
  enabled right before you submit. Firing submit into a mid-validation form records a failure that
  isn't the app's fault, and a real user wouldn't do it either.
- Some non-navigating interactions REBUILD part of the DOM — selecting a radio / checkbox / dropdown
  wired to a Stimulus/Turbo controller (`data-action="…#build"` / `…#rebuild`, or a control with
  `data-controller` / a `data-*-affected` attribute that names a region to regenerate). Firing one
  DETACHES the elements it rebuilds, so a handle you grabbed a moment earlier throws "Element is not
  attached to the DOM" when you act on it next — even elsewhere in the same script. Two-part
  discipline: (1) DETECT it before acting — read the control's attributes
  (`await loc.getAttribute("data-action")`, `data-controller`, `data-*-affected`); if the action
  names a build/rebuild verb, treat the interaction as DOM-mutating. (2) HANDLE it — make the
  rebuilding interaction the LAST action of its step (the step-end settle lets the new DOM commit;
  act on the dependents in the NEXT step), or, to continue in the same step, re-derive each
  dependent from a FRESH locator and wait for it to (re)attach —
  `page.waitForSelector(sel, { state: "attached" })`, `page.waitForResponse(...)` for the fetch that
  drives the rebuild, or `locator.waitFor()`. Never reuse a handle grabbed before the rebuild, and
  when several fields each rebuild, give each its own step — batching them is what produces the
  detached-element failures. (A sandbox script has no way to invoke the step-end settle mid-step
  today; splitting steps is the reliable lever.)
- A form submit that FAILS validation usually returns HTTP 422 and re-renders the form with errors.
  In Rails/Turbo apps that comes back as a Turbo-stream rebuild, NOT a navigation. A SUCCESSFUL
  submit navigates, but a submit that MIGHT fail in place shouldn't use `humanClickAndWaitForURL` —
  it hangs to the timeout on failure. Instead `humanClick` the submit, then wait for EITHER outcome:
  the URL to change (success) OR an error/flash to appear (failure). Observe the re-rendered page. To
  FIND the errors, do NOT assume a class name: a `snapshotForAI` outline surfaces ACCESSIBILITY
  semantics, not CSS classes, and many design systems attach NO ARIA to error markup (no
  `aria-invalid`, no `role="alert"`), so the error is just an anonymous text node in the outline.
  Instead (a) search the snapshot for the message TEXT, or (b) read the DOM for the app's real error
  class — `page.$$eval(".<app-error-class>", els => els.map(e => e.textContent))`, discovering that
  class once from a failing field's `outerHTML`. Don't reach for `[aria-invalid]` / `.is-invalid` /
  `.field_with_errors`: those are Bootstrap / Rails-default markers that a design-system app commonly
  overrides or suppresses, so all three match nothing. Note that some errors attach to an
  association or the record's base, not a single field, and by design render nowhere inline — a
  generic flash banner is then the only user-visible signal.
- Verify through the surfaces a SHIPPED user sees — the on-screen flash and inline field messages.
  Do NOT click dev-only diagnostics (a "View Submitted Errors" / debug-drawer button, a `?debug=`
  panel): they don't exist in production, so reading them proves nothing about the real experience
  and reads wrong in a demo recording.
- A click timeout or `page.isVisible(sel)` returning false usually means hidden, not missing:
  snapshot, find the toggle/menu/tab that reveals the element, click that, then retry.
<!-- canary:end rule-visible-interaction -->

<!-- canary:snippet rule-screenshot cli=npx-cli -->
After each `npx @usecanary/cli run --step`, the daemon auto-captures ONE screenshot of the step's
last-opened tab and binds it to that step in the report. So:

- Keep one primary named page per step — the report screenshot is always the page you mean.
- If a step opens several tabs, open the one you want featured last.
- `saveScreenshot(...)` images land in `~/.canary/tmp/` and are NOT in the report — they're
  extras for debugging.
<!-- canary:end rule-screenshot -->

<!-- canary:snippet rule-caption -->
- Captions carry the narration the video can't: WHY you're doing something, what a viewer should
  watch for, or why a result matters. Reach for `await page.showCaption("…")` generously to explain
  intent — open each meaningful step or section with a one-line "why" rather than saving captions
  only for detours. The bar is "would a viewer understand the reason without me here?", not "is this
  strictly necessary?".
- Don't echo the screen, though: a caption that restates an action ("Click Submit") or repeats the
  step name is noise. Caption the reasoning, the precondition, or what to watch for — never the
  click itself.
- Always caption a deviation from what was asked — when you improvise a workaround, set up a
  precondition, or take an unrequested path to reach the feature under test. In a non-interactive
  run no one is watching live, so a one-line "doing X because Y" is what tells a later viewer the
  detour was deliberate, not a mistake.
- Keep each caption to ONE short sentence — it must fit two lines on screen (~100 characters);
  anything longer is clamped and the overflow is lost. Split a longer thought across captions on
  successive steps. They fade after a few seconds (pass `{ durationMs }` to adjust).
- Recording for a cinematic edit? Start with `canary session start --cinematic`. The overlay is
  then suppressed (the themed captions burned in by `session end --cinematic` replace it), but the
  text you pass still feeds the narration as your stated intent — so keep writing captions exactly
  as you would otherwise; they're the clearest signal of WHY each step matters.
- Want a music video instead of spoken narration? `session end --song` scores the whole run with
  one AI-generated song whose lyrics are written about the steps, captions timed to the singing
  (still record with `session start --cinematic` to suppress overlays). Steer it with
  `--prompt "<genre/vibe>"`; `--no-captions` drops the burned lyric subtitles. Needs the `claude`
  CLI plus a lyrics-capable music model — a local/remote ACE-Step server (`$CANARY_ACESTEP_URL`) or
  a Gemini key. Captions are timed to the actual vocals when a transcriber is found on PATH
  (autodetected, English-only: `whisperx` → `mlx_whisper` → whisper.cpp `whisper-cli`; models come
  from the HuggingFace cache); override with `$CANARY_TRANSCRIBER`, `$CANARY_WHISPER_CLI`,
  `$CANARY_WHISPER_MODEL`. For the tightest timing, point `$CANARY_TRANSCRIBE_URL` at an
  OpenAI-compatible server (e.g. a local Whisper-Large-v3-Turbo; `$CANARY_TRANSCRIBE_MODEL` /
  `$CANARY_TRANSCRIBE_API_KEY`) — it wins over the CLI backends. `$CANARY_SONG_FILE` reuses a generated song. The voice/music env vars ($CANARY_SAY_COMMAND, $CANARY_OMLX_URL, …) are listed in
  `canary session end --help`.
<!-- canary:end rule-caption -->

<!-- canary:snippet rule-pass-fail -->
- Decide pass/fail ONLY against the flow's stated success criteria — the behavior you set out to
  verify. YOU own the run's verdict: declare it when you finish with `session end --pass` or
  `session end --fail "<reason>"`. A failed INTERMEDIATE step is not a failed run — a click that
  timed out, a dead end you backed out of, or a retry you abandoned are honest evidence in the
  report but do NOT decide the outcome; only your declared verdict does. So don't contort the flow
  to keep every step green — take the obvious path, and if a step fails, recover and carry on, then
  judge the whole run at the end. (Declare no verdict and the run falls back to "failed if any step
  exited non-zero" — fine for a quick human run, but as the agent you should almost always declare.)
- Console and page errors are captured as evidence, not verdicts. They DON'T by themselves fail a
  run — most are pre-existing noise (third-party scripts, analytics, unrelated warnings). Treat an
  error as a failure only when it IS the thing under test or actually blocks the flow.
- Same for the network: a non-2xx response (e.g. a 422 from form validation) is not a failure
  unless it's the behavior you're verifying. Expected validation, or an error on a field unrelated
  to the change, is not a regression — note it (`WARN`) and move on.
- When unsure, judge against intent — "did the thing I'm testing work?", not "did anything on the
  page emit an error?". Record incidental issues so a human can see them; don't fail the run on them.
<!-- canary:end rule-pass-fail -->

<!-- canary:snippet rule-fail-fast cli=npx-cli -->
- End each script by logging the state you need for the next decision — stdout is your
  observation channel.
- Use short timeouts (`npx @usecanary/cli run --timeout 10`) so a step fails fast instead of hanging on a
  missing element.
- In assertion / extraction steps, degrade gracefully — log a `WARN` / `FAIL` line instead of
  crashing, so the step still records its evidence. While exploring, a missed selector means
  look again (snapshot, fix, retry as a new step), not a silent fallback.
- End before you stop: `npx @usecanary/cli stop` shuts the daemon down and aborts any live session,
  skipping its report.html — always `npx @usecanary/cli session end <id>` first.
<!-- canary:end rule-fail-fast -->

- Stay in this conversation — don't delegate the flow to a subagent; the point is to collaborate.
- Name steps by intent (`observe-cart`, `enable-feature-flag`, `submit-login-form`).
- Never skip `session end` — without it there is no report.
- **File uploads:** write the file into the sandbox temp dir first (`writeFile(name, data)`), then
  `await page.setInputFiles(inputSelector, name)` — call this on `page`, never on a locator.
  `page.setInputFiles` is the Canary helper that reads the named file host-side from the sandbox
  temp dir; `locator.setInputFiles(name)` is raw Playwright, which tries to resolve `name` as a
  real filesystem path and throws (the sandbox has none). Only hand off to takeover when the file
  can't be produced in-script (the user needs to pick a real local file in the live browser); after
  they attach it, continue recording.
- **Split / dropdown button submenus:** after clicking a button that reveals a submenu, snapshot
  immediately — before any other call — to capture the menu while it's open.
- **Cinematic mode: flag both ends.** The pass that adds narration + burned captions runs at
  `session end` — pass `--cinematic` (and `--open`) to `npx @usecanary/cli session end`, not to
  `run`. But ALSO pass `--cinematic` to `session start` when you know the recording is for a
  cinematic edit: that suppresses the `page.showCaption` overlays during recording (their text
  still feeds the narration) so they don't double up with the burned captions. Re-running
  `session end --cinematic` on an already-ended session is safe — it rebuilds the report
  idempotently — but if the session wasn't started with `--cinematic`, the overlays are already
  baked into the video and you'll get double captions (the command warns you).
