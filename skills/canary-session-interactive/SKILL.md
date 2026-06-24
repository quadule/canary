---
name: canary-session-interactive
description: Record a Canary QA session collaboratively, in the main conversation — the agent drives autonomously but pauses to ask you for direction when unsure, and can hand you the live browser to do steps it can't (log in, flip a feature flag, change settings), capturing your actions as recorded steps. Use when a flow needs your input or manual setup mid-run. Trigger phrases — "record this with me", "interactive session", "I'll need to take over", "let me do part of it", "ask me if you get stuck".
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
as it records. Use the **canary-scripting** skill for the API.

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
2. **Ask the user to take over** and say when they're finished. They click / type / navigate in the
   already-open browser window; the virtual cursor hides while they drive. Wait for their "done" —
   don't run steps meanwhile (the session rejects them mid-takeover).
3. **Stop and capture (you run this):** `npx @usecanary/cli session takeover "$id" --stop`. The
   recorder turns the user's actions into generated Playwright source, prints it, and records it as
   the step. (Use `--cancel` instead to discard.) Read the printed code, then carry on driving.

The user's actions are in the video/trace either way; `--stop` additionally preserves the generated
Playwright code as the step's source (a clean record, and what a later Playwright→RSpec step would
build on). Read the printed code, then continue driving the flow.

## Workflow

1. Ensure the runtime: `npx @usecanary/cli install` (one-time).
2. Start: `id=$(npx @usecanary/cli session start --name "<flow>")` (headed — needed so the user can
   take over).
3. **LOOK** — observe before acting; an observe step records like any other (log `page.url()`,
   `page.title()`, `(await page.snapshotForAI()).full`).
4. **DECIDE** the next small action. If it's ambiguous or not yours to do, ask the user / hand over.
5. **ACT** — run that action as an intent-named step (`npx @usecanary/cli run --session "$id" --step
   <name>`), or take over (above) when the user must do it.
6. **READ** stdout + exit code; on failure observe and retry as a new step.
7. Loop 3–6 until done; finish with explicit assertion step(s) logging `PASS`/`FAIL`.
8. End + render: `npx @usecanary/cli session end "$id"` → `~/.canary/sessions/<id>/report.html`.
9. Offer **canary-review** (or `npx @usecanary/ui`) to browse it.

## Hard rules

<!-- canary:snippet rule-observe-first -->
- Unknown page? Snapshot first, then act: read `(await page.snapshotForAI()).full` to see what
  is there, pick a semantic selector from it (`getByRole`, `getByText`), then interact. Never
  guess selectors blind.
- Known page or selectors? Skip the snapshot and use direct selectors — faster and more reliable.
- After a navigation the new page often renders asynchronously (client-side routing / SPAs swap
  content without a full document load). Don't snapshot or assert the instant a click returns.
  Prefer acting on or waiting for a KNOWN element on the destination (`getByRole`/`getByText`) —
  Playwright auto-waits for it, which both confirms the navigation and avoids reading stale
  content. When you must observe an unknown post-navigation page, `await page.waitForSettled()`
  first — it waits (bounded) for the DOM to stop changing, framework-agnostically. Avoid fixed
  `waitForTimeout`, and `waitForLoadState("networkidle")` (it can hang on apps with live connections).
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
- Toggle a checkbox or radio by clicking its LABEL, not the input — apps routinely hide the real
  `<input>` and draw a custom control with CSS, so the input is zero-size/invisible and clicking
  it fails or does nothing. `humanClick` the visible label text (`getByText("Accept terms")`, or
  the `<label>`); a user clicks the words and the box, not the hidden input.
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
- Captions are the exception, not the rule — by default add NONE. The video already shows what's
  happening, so most steps need no caption. Reach for `await page.showCaption("…")` only when
  something genuinely non-obvious needs explaining for a human viewer: an off-happy-path
  precondition, WHY a step is being done, or what to watch for next. Never narrate the obvious or
  echo a step name — a caption that restates "Click Submit" is noise. Keep them short; they fade
  after a few seconds (pass `{ durationMs }` to adjust).
<!-- canary:end rule-caption -->

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
