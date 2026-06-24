---
name: canary-scripting
description: The Canary sandbox scripting API for browser automation. Use when writing or debugging a Canary script — looking up how to open a page, click, fill, extract text, observe an unknown page with snapshotForAI, evaluate in the page, take a screenshot, persist data between steps, or understand sandbox limits (no imports, timeouts). Trigger phrases — "how do I click in canary", "canary page API", "what's on this page", "explore a page in canary", "snapshotForAI", "saveScreenshot signature", "get text from the page", "why is my canary script timing out", "open a new tab in canary".
license: MIT
metadata:
  author: usecanary
  version: 0.4.4
  category: reference
  tags:
    - canary
    - browser-automation
    - playwright
    - scripting
---

# Canary scripting API

Canary scripts are plain **async JavaScript** run in a QuickJS sandbox with a Playwright-like API.
Both `canary-browser run` (one-off) and `canary run --session` (recorded step) execute the same way:
top-level `await`, with `browser`, `console`, and the file helpers available as globals.

<!-- canary:snippet rule-drive-with-canary cli=npx-cli -->
- Drive the browser only through Canary — the `npx @usecanary/cli` CLI and the scripts it runs. Do NOT use
  Claude in Chrome, a computer-use / screenshot tool, or any other browser automation to navigate,
  click, fill, or read a page, even for a single step. Those bypass Canary's sandbox, the on-screen
  cursor, and the trace / video / HAR capture, so nothing is recorded or verifiable. If a step
  tempts you toward another browser tool, write a Canary script instead.
<!-- canary:end rule-drive-with-canary -->

## When to use

- Writing a script to drive a browser with Canary
- Looking up a page or locator method (`goto`, `locator`, `evaluate`, `waitForSelector`, `screenshot`)
- Persisting a page or a file between steps of a session
- Debugging a timeout, a missing global, or a "page closed" error

## Examples

### Example 1: open a page and read it
User says: "navigate to a site and get the title in canary" or "how do I read text off the page?"
Use a **named** page so it persists across steps, then `goto` and `evaluate`/`locator`. See *Quick start*.

### Example 2: click / fill / extract
User says: "click the login button", "fill the search box", "scrape the headlines"
`page.humanClick(locator)` / `page.humanFill(locator, value)` to act like a real user; `page.textContent(selector)` or `page.evaluate(fn)` to pull structured data in one round-trip.

### Example 3: screenshot
User says: "take a screenshot" or "what's the saveScreenshot signature?"
`const buf = await page.screenshot({ fullPage: true }); await saveScreenshot(buf, "home.png");` — note **buffer first**, and that `saveScreenshot` is a top-level global, not `browser.saveScreenshot`.

### Example 4: observe an unknown page
User says: "I don't know the selectors", "what's on this page?", "explore before acting"
`(await page.snapshotForAI()).full` → an aria outline of the page. Read it to pick a role/text selector, then act. See *Observing the page*.

## Quick start

<!-- canary:snippet ex-quickstart fenced=js -->
```js
const page = await browser.getPage("main");          // named, persistent page
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());

const headings = await page.evaluate(() =>
  [...document.querySelectorAll("h1, h2")].map((h) => h.textContent.trim())
);
console.log(JSON.stringify(headings));

await page.humanClick(page.getByRole("link", { name: "More information" }));
const buf = await page.screenshot({ fullPage: false });
await saveScreenshot(buf, "page.png");               // saveScreenshot(buffer, name)
```
<!-- canary:end ex-quickstart -->

## Observing the page

<!-- canary:snippet ex-snapshot fenced=js -->
```js
const page = await browser.getPage("main");
const snap = await page.snapshotForAI(); // { full, incremental? }
console.log(page.url(), await page.title());
console.log(snap.full); // aria outline — pick a role/text selector from this
// then act: await page.humanClick(page.getByRole("button", { name: "Continue" }));
// after changes, page.snapshotForAI({ track: "main" }) returns just the incremental diff
```
<!-- canary:end ex-snapshot -->

<!-- canary:snippet api-snapshot -->
- `page.snapshotForAI()` returns `{ full, incremental? }` — `full` is an aria outline of the
  page: roles, accessible names, `[ref=eN]` markers on actionable nodes. Read it to pick a
  semantic selector — `page.getByRole("button", { name: "Continue" })`,
  `page.getByText("Sign in")` — then act.
- Options `{ track?, depth?, timeout? }`: re-run `page.snapshotForAI({ track: "main" })` after
  the page changes to get just the `incremental` diff; `{ depth: N }` caps the tree on huge
  pages; `timeout` bounds the walk.
- `page.locator("aria-ref=e12")` works for an immediate action in the same script only — refs go
  stale across steps and after navigations. Prefer re-deriving a semantic selector.
<!-- canary:end api-snapshot -->

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

- End each script by logging the state you need for the next decision — stdout is your observation
  channel.

## The essentials

<!-- canary:snippet api-globals -->
Every script gets these globals:

- `browser` — pre-connected browser handle (see the script API)
- `console` — `log` / `info` / `warn` / `error`, captured per run
- `setTimeout` / `clearTimeout` — basic timers
- `saveScreenshot(buffer, name)` — save a screenshot buffer (async — await it)
- `writeFile(name, data)` / `readFile(name)` — small-file persistence (async — await them)
<!-- canary:end api-globals -->

<!-- canary:snippet rule-data-passing -->
- Browser state persists across steps: named pages (and their cookies) stay open between scripts
  within a session — reuse the same page name so each step picks up where the last left off.
- Anonymous `newPage()` tabs are closed when each script ends.
- To pass values between steps: `writeFile("state.json", JSON.stringify(x))` in one step,
  `JSON.parse(await readFile("state.json"))` in the next.
<!-- canary:end rule-data-passing -->

- One **primary named page per step** keeps the per-step report screenshot correct (the full rule
  is in [`references/REFERENCE.md`](references/REFERENCE.md)).
- **No module system** — no `import`/`require`. Inline any helpers.
- **Timeouts** — both CPU and wall-clock are enforced; long loops or unresolved promises abort the script.

For the **complete API** — every page/locator/`browser` method, signatures, the per-step screenshot rule, and sandbox limits — see [`references/REFERENCE.md`](references/REFERENCE.md).
