---
name: canary-automate
description: Drive a real browser for a one-off task with Canary — navigate, click, fill, scrape, screenshot — and return the result. Nothing is recorded. Use when the user asks to automate a browser task, scrape a page, fill a form, or check something on a site without needing a report. Trigger phrases — "go to X and get Y", "scrape this page", "automate this browser task", "log in and check", "take a screenshot of".
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
    - browser-automation
    - scraping
---

# Canary automate (one-off)

Run a script against a real browser and return the result — ephemeral, nothing recorded.

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

## When to use

- A quick, one-shot browser task: navigate, extract, fill, screenshot.
- Scraping or checking a page where you don't need a trace / video / report.
- For a recorded, verifiable run **with** a report, use **canary-session** instead.

## Examples

### Example 1: scrape
User says: "get the top 10 Hacker News titles" or "scrape the headlines"
Write a script that opens the page and `evaluate`s the data, run it, return the JSON it logs.

### Example 2: check
User says: "is the pricing page up and what's the headline?" or "screenshot the homepage"
`goto`, read the element (or `screenshot`), report.

## Workflow

1. If the runtime isn't installed: `npx @usecanary/cli install` (one-time; downloads Chromium).
2. Write a short, focused script with the canary-scripting API (`browser.getPage`, `page.goto`,
   `locator`/`evaluate`, `console.log` the result), observing first on unknown pages (see *Hard
   rules*).
3. Run it: `npx @usecanary/browser run ./script.js` (or pipe the script via stdin).
4. If the result is empty or a selector missed, **observe and retry**: run a second short script that
   logs `page.url()`, `page.title()`, and `(await page.snapshotForAI()).full` (or a targeted
   `locator(...).count()`), pick a better selector, re-run. Named pages persist between runs, so
   state carries over.
5. Report the script's stdout. On optional extractions, degrade gracefully (log a `WARN`, don't
   crash) — but don't paper over a miss you can fix by observing.
6. Cleanup (optional): the run leaves a shared background daemon up for reuse. To shut it (and any
   browser) down, run `npx @usecanary/browser stop` (alias of `canary stop` / `canary daemon stop`).

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
