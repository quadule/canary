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
