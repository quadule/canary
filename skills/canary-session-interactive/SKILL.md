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
- After a click that navigates (Turbo / SPA especially), `page.url()` and the new content lag until
  the request lands — don't read them the instant the click returns. `await page.waitForURL(<url |
  regex>)` or `await page.waitForSettled()`, then read. Canary does track the new URL; it just isn't
  there immediately.
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
  anything off the happy path. Hand the user the live browser, let them do it, and capture what
  they did as a recorded step (see *Manual takeover*).

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
- Unknown page? Snapshot first, then act: read `(await page.snapshotForAI()).full` to see what
  is there, pick a semantic selector from it (`getByRole`, `getByText`), then interact. Never
  guess selectors blind.
- Known page or selectors? Skip the snapshot and use direct selectors — faster and more reliable.
- The snapshot covers the whole page no matter where it's scrolled — never add a scroll step just to
  observe. To cut the repeated nav/sidebar chrome, scope it with `{ selector: "main" }`; after an
  interaction, pass `{ track: "main" }` to get just what changed instead of re-reading (and
  re-slicing) the full outline.
- After a navigation the new page often renders asynchronously (client-side routing / SPAs swap
  content without a full document load). Don't snapshot or assert the instant a click returns.
  Prefer acting on or waiting for a KNOWN element on the destination (`getByRole`/`getByText`) —
  Playwright auto-waits for it, which both confirms the navigation and avoids reading stale
  content. When you must observe an unknown post-navigation page, `await page.waitForSettled()`
  first — it waits (bounded) for the DOM to stop changing, framework-agnostically. Avoid fixed
  `waitForTimeout`, and `waitForLoadState("networkidle")` (it can hang on apps with live connections).
- `page.url()` is a cached value updated by an async event, so right after a client-side navigation
  it can still read the OLD url — especially a Turbo/SPA visit, whose URL only changes once its
  fetch lands. To read or assert the post-navigation URL, `await page.waitForURL(<url|regex|fn>)`,
  or `await page.waitForSettled()` then read `page.url()`, or read the live value with
  `await page.evaluate(() => location.href)`.
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
  first (as its own action), then interact. Any `scrollIntoViewIfNeeded` / `page.isVisible(sel)`
  checks fold into the interaction's own script — keep them out of the step list as bookkeeping.
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
  interaction let the page settle (`await page.waitForSettled()` if anything's in flight) and
  check what changed — a validation message, a new field, the button's state — before moving on,
  and re-check once more right before you submit. Firing submit into a mid-validation form records
  a failure that isn't the app's fault, and a real user wouldn't do it either.
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
- Captions explain what the video can't show on its own — use them sparingly and never to narrate
  the obvious. A caption that restates a step ("Click Submit") or echoes a step name is noise; skip
  it. Reach for `await page.showCaption("…")` when something a viewer can't infer from the screen
  needs saying: an off-happy-path precondition, WHY a step is being done, or what to watch for next.
- Especially caption a deviation from what was asked — when you improvise a workaround, set up a
  precondition, or take an unrequested path to reach the feature under test. In a non-interactive
  run no one is watching live, so a one-line "doing X because Y" is what tells a later viewer the
  detour was deliberate, not a mistake. Keep captions short; they fade after a few seconds (pass
  `{ durationMs }` to adjust).
<!-- canary:end rule-caption -->

<!-- canary:snippet rule-pass-fail -->
- Decide pass/fail ONLY against the flow's stated success criteria — the behavior you set out to
  verify. A step fails (exit non-zero, or log `FAIL`) when THAT behavior is wrong; otherwise it
  passes. The session is marked failed if any step's script exits non-zero, so reserve a non-zero
  exit / `FAIL` for a genuine criteria miss — not incidental noise.
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
