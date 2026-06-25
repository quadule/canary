# Canary scripting API — full reference

Scripts run in a QuickJS sandbox. The body is top-level JavaScript with `await`.

## Globals

<!-- canary:snippet api-globals -->
Every script gets these globals:

- `browser` — pre-connected browser handle (see the script API)
- `console` — `log` / `info` / `warn` / `error`, captured per run
- `setTimeout` / `clearTimeout` — basic timers
- `saveScreenshot(buffer, name)` — save a screenshot buffer (async — await it)
- `writeFile(name, data)` / `readFile(name)` — small-file persistence (async — await them)
<!-- canary:end api-globals -->

## `browser`

<!-- canary:snippet api-browser -->
- `browser.getPage(nameOrId)` — get-or-create a named page, or attach to an existing tab by the
  `id` from `listPages()`. Named pages persist across steps in a session — call with the same
  name to reuse the tab.
- `browser.newPage()` — an anonymous page, auto-closed when the script ends; does not persist.
- `browser.listPages()` — list every open tab: `[{ id, url, title, name }]` (`name` is `null`
  for tabs you never named).
- `browser.closePage(name)` — close and forget a named page.
<!-- canary:end api-browser -->

## Top-level file helpers

<!-- canary:snippet api-file-helpers -->
All file I/O is async (await it), sandboxed to `~/.canary/tmp/` (no filesystem escape), and
returns the full path to the file:

- `saveScreenshot(buffer, name)` — persist a screenshot buffer; buffer first:
  `const path = await saveScreenshot(await page.screenshot(), "home.png");`
- `writeFile(name, data)` — write a small file (e.g. JSON state):
  `await writeFile("results.json", JSON.stringify(data));`
- `readFile(name)` — read it back (returns the contents as a string):
  `const data = JSON.parse(await readFile("results.json"));`
<!-- canary:end api-file-helpers -->

## Console

<!-- canary:snippet api-console -->
- `console.log` / `console.info` write to stdout; `console.warn` / `console.error` write to
  stderr. Top-level `console.log` is your script's output channel.
- `console.log` inside `page.evaluate(() => …)` runs in the page and is captured into the
  session's console artifact instead.
<!-- canary:end api-console -->

## `Page` — common methods

<!-- canary:snippet api-playwright-note -->
Pages returned by `browser.getPage()` and `browser.newPage()` are full Playwright Page objects —
the same API (`goto`, `click`, `fill`, `locator`, `evaluate`, `getByRole`, `waitForSelector`, …):
https://playwright.dev/docs/api/class-page
<!-- canary:end api-playwright-note -->

<!-- canary:snippet api-playwright-methods -->
- `page.goto(url, { waitUntil: "domcontentloaded" })` — navigate; `waitUntil` is `"load"` /
  `"domcontentloaded"` / `"networkidle"` (prefer `"domcontentloaded"` on dev servers)
- `page.title()` / `page.url()` — current title / URL
- `page.snapshotForAI(options)` — AI-optimized page outline (whole page, any scroll position);
  returns `{ full, incremental? }`; options `{ selector?, track?, timeout? }` — `selector` scopes to
  an element (e.g. `"main"`, to drop nav chrome after a full first look proves it is noise),
  `track` returns just the diff since the last same-key snapshot (the two are mutually exclusive);
  omit `depth` — a shallow tree forces expensive fallbacks and hides late-page fields
- `page.getByRole(role, { name })` / `page.getByText(text)` — semantic locators (survive re-renders)
- `page.textContent(sel)` / `page.innerText(sel)` / `page.innerHTML(sel)` /
  `page.getAttribute(sel, name)` — read by selector
- `page.inputValue(sel)` / `page.isChecked(sel)` / `page.isVisible(sel)` / `page.isHidden(sel)` —
  input and visibility state
- `page.humanClick(target)` / `page.humanFill(target, text)` — Canary helpers that act like a
  person for the recording: smooth-scroll the element into view, glide the on-screen cursor onto
  it and let it land, then click — or, for a fill, focus and type with real key events. `target` is
  a selector string or a locator. Prefer these for recorded interactions — they reveal the target
  for you, so you don't call `scrollIntoViewIfNeeded` first.
- `page.fill(sel, value)` / `page.click(sel)` / `page.type(sel, text)` / `page.press(sel, key)` —
  lower-level acts on elements (`fill` sets the value atomically — no cursor travel or typing on
  camera; reach for `humanClick` / `humanFill` in recordings)
- `page.showCaption(text, opts?)` — Canary helper: overlay a short caption on the page to label a
  moment in the recording for a human viewer; fades after `opts.durationMs` (default 3000).
  Cosmetic only — use sparingly, not to echo step names
- `page.showSpotlight(target?)` — Canary helper: animate a spotlight vignette to focus on an
  element (`target` is a selector or locator). The spotlight opens wide then tightens to
  circumscribe the element's bounding box, drawing the reviewer's eye before you interact.
  Omit `target` to spotlight the current cursor position. Use for subtle elements a viewer
  might miss — validation errors, small toggles, non-obvious fields
- `page.reveal(target)` — Canary helper: smooth-scroll a region into view and glide the cursor onto
  it WITHOUT clicking (the `humanClick` motion minus the press). Use to show something in the
  recording; never `window.scrollTo` / `page.evaluate(() => scrollTo(...))` (invisible on camera).
  You don't need it to observe — `snapshotForAI` sees the whole page regardless of scroll
- `page.waitForSettled(opts?)` — Canary helper: wait (bounded) for the page to stop changing —
  document load then DOM-mutation quiescence (`opts.quietMs`, `opts.timeoutMs`). Framework-agnostic
  and won't hang on live connections (it watches the DOM, not the network). Use before observing an
  unknown page after a client-side navigation
- `page.waitForSelector(sel, { state, timeout })` (`state`: `"attached"` / `"visible"` /
  `"hidden"` / `"detached"`) / `page.waitForURL(pattern)` (polls the live URL, so it resolves on
  History API / Turbo / SPA navigations too; `pattern` is a glob, RegExp, or predicate) /
  `page.waitForLoadState(state)` / `page.waitForFunction(fn)` / `page.waitForTimeout(ms)` — waiting
- `page.setInputFiles(target, files, opts?)` — Canary helper: attach files to a file `<input>`.
  `files` is one filename or an array; each must already live in the sandbox temp dir (write it
  with `writeFile(name, data)` first, or have the user drop it in via takeover). The bytes are read
  host-side — confined to that dir — and handed to the browser as an in-memory payload, so a script
  can only upload files it put there. Glides the cursor to the control when it's visible. `target`
  is a selector or locator
- `page.screenshot({ fullPage })` — capture a screenshot Buffer; save it with `saveScreenshot(...)`
- `page.evaluate(fn[, arg])` / `page.$eval(sel, fn)` / `page.$$eval(sel, fn)` — run plain
  JavaScript in the page context (real DOM; args/returns must be serializable)
- `page.locator(sel)` — a Locator for chained actions (`.click()`, `.fill(value)`,
  `.pressSequentially(text)` to type with real key events, `.textContent()`, `.first()`, …);
  `.scrollIntoViewIfNeeded()` brings an offscreen element into the viewport without clicking it —
  only needed when revealing without acting, since `humanClick` / `humanFill` already reveal first
- `page.keyboard.press/type/down/up(...)` / `page.mouse.move/click/down/up(...)` — low-level input
- `page.reload()` / `page.goBack()` / `page.goForward()` — history;
  `page.content()` / `page.setContent(html)` — full HTML
- `page.on("console", handler)` — observe page console events
<!-- canary:end api-playwright-methods -->

## `Locator` — `page.locator(selector)`

Actions: `.click()`, `.fill(value)`, `.check()`, `.uncheck()`, `.selectOption(value)`, `.hover()`, `.focus()`.
Reads: `.textContent()`, `.innerText()`, `.getAttribute(name)`, `.inputValue()`, `.count()`.
State: `.isVisible()`, `.isEnabled()`, `.isChecked()`.
Refine: `.first()`, `.last()`, `.nth(i)`, `.filter({ hasText })`, `.all()` (→ `Locator[]`).
Semantic factories (also `Locator`): `page.getByRole(role, { name })`, `page.getByText(text)`.

## Observing the page — `snapshotForAI`

<!-- canary:snippet api-snapshot -->
- `page.snapshotForAI()` returns `{ full, incremental? }` — `full` is a deep aria outline of the
  page: roles, accessible names, `[ref=eN]` markers on actionable nodes. On an unknown page, start
  with the full-depth snapshot so you can see the whole task surface, including content near the
  end of the page. Read it to pick a semantic selector — `page.getByRole("button", { name:
  "Continue" })`, `page.getByText("Sign in")` — then act. The outline covers the WHOLE page
  regardless of scroll position, so you never need to scroll to observe.
- Keep it small only when there is a clear reason — these options are mutually exclusive, and the
  call rejects if you pass both:
  - `{ selector }` scopes the outline to one element — `page.snapshotForAI({ selector: "main" })`
    drops repeated nav/sidebar chrome. Use it only after a full snapshot proves the page is
    overwhelmingly large or dominated by irrelevant chrome, or when an active dialog/form is the
    whole task surface. Do not default to truncating or shallow snapshots; that hides late-page
    fields and causes extra observe/retry loops.
  - `{ track }` returns only what CHANGED since your last snapshot with the same key —
    `page.snapshotForAI({ track: "main" })` after an interaction. The first tracked call returns the
    full tree to set the baseline; later calls (this step or a future one) return just the diff in
    both `full` and `incremental`. Tracking resets on a full page load. Best AFTER an interaction, to
    see what it did.
- `timeout` bounds the walk. Don't pass `depth` — a shallow snapshot silently omits elements,
  causing missed controls, avoidable fallback to screenshots or full HTML, and extra round trips.
- `page.locator("aria-ref=e12")` works for an immediate action in the same script only — refs go
  stale across steps and after navigations. Prefer re-deriving a semantic selector.
<!-- canary:end api-snapshot -->

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

Keeping it small: snapshot once to orient; after the page changes, use `{ track }` incrementals
instead of a full re-dump. If you only need a specific value, skip the snapshot entirely and read
it directly with `locator(sel).innerText()` / `.count()`. Don't limit depth — a truncated
snapshot causes consecutive observe steps and expensive screenshot fallbacks.

<!-- canary:snippet ex-snapshot fenced=js -->
```js
const page = await browser.getPage("main");
const snap = await page.snapshotForAI(); // full-depth first look
console.log(page.url(), await page.title());
console.log(snap.full); // aria outline — pick a role/text selector from this
// then act: await page.humanClick(page.getByRole("button", { name: "Continue" }));
// after changes, page.snapshotForAI({ track: "main" }) returns just the incremental diff
```
<!-- canary:end ex-snapshot -->

## The per-step screenshot rule (sessions)

<!-- canary:snippet rule-screenshot cli=npx-cli -->
After each `npx @usecanary/cli run --step`, the daemon auto-captures ONE screenshot of the step's
last-opened tab and binds it to that step in the report. So:

- Keep one primary named page per step — the report screenshot is always the page you mean.
- If a step opens several tabs, open the one you want featured last.
- `saveScreenshot(...)` images land in `~/.canary/tmp/` and are NOT in the report — they're
  extras for debugging.
<!-- canary:end rule-screenshot -->

## Passing state between steps

<!-- canary:snippet rule-data-passing -->
- Browser state persists across steps: named pages (and their cookies) stay open between scripts
  within a session — reuse the same page name so each step picks up where the last left off.
- Anonymous `newPage()` tabs are closed when each script ends.
- To pass values between steps: `writeFile("state.json", JSON.stringify(x))` in one step,
  `JSON.parse(await readFile("state.json"))` in the next.
<!-- canary:end rule-data-passing -->

## Dev servers

<!-- canary:snippet rule-dev-server -->
For local dev servers (Next.js, Vite, …) prefer
`await page.goto(url, { waitUntil: "domcontentloaded" })` — the default `"load"` wait can hang
on HMR, streaming, or other long-lived dev-server connections. Use `"load"` only when you
specifically need every subresource to finish loading.
<!-- canary:end rule-dev-server -->

## Sandbox limits

<!-- canary:snippet api-sandbox-env -->
Scripts execute inside a QuickJS WASM sandbox with no arbitrary access to the host system.
This is NOT Node.js — there is no module system and no Node API:

- `require()` / `import()` — no module loading; inline any helpers in the script
- `process`, `fs` / `path` / `os` — no process or direct filesystem access (use the file helpers)
- `fetch` / `WebSocket` — no direct network access (the page does the networking)
- `__dirname` / `__filename` — no path globals

Memory and CPU limits are enforced, and both CPU time and wall-clock time are bounded — infinite
loops or never-settling promises abort the script. Values crossing `evaluate` / `$eval` must be
JSON-serializable.
<!-- canary:end api-sandbox-env -->

## Resilience & failure discipline

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

Recommended pattern for assertion / extraction steps:

```js
const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.getPage("main");
await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded" });
const ok = await safe(() => page.waitForSelector("tr.athing", { timeout: 15000 }).then(() => true), false);
if (!ok) {
  console.log("WARN: rows not found — page changed or rate-limited");
} else {
  const titles = await safe(() => page.evaluate(() =>
    [...document.querySelectorAll("span.titleline > a")].slice(0, 10).map((a) => a.textContent)
  ), []);
  console.log(JSON.stringify(titles));
}
```
