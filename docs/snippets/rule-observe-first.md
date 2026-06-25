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
