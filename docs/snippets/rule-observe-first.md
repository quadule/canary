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
