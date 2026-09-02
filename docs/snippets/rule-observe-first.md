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
  wait at all: Dailies settles the page (load + network-idle + DOM quiescence) at the END of every
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
