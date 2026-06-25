- `page.snapshotForAI()` returns `{ full, incremental? }` — `full` is an aria outline of the
  page: roles, accessible names, `[ref=eN]` markers on actionable nodes. Read it to pick a
  semantic selector — `page.getByRole("button", { name: "Continue" })`,
  `page.getByText("Sign in")` — then act. The outline always covers the WHOLE page regardless of
  scroll position, so you never need to scroll to observe (and never hand-slice the string — scope
  it instead).
- Keep it small two ways — mutually exclusive, the call rejects if you pass both:
  - `{ selector }` scopes the outline to one element — `page.snapshotForAI({ selector: "main" })`
    drops the repeated nav/sidebar chrome. Best for the FIRST look at a page.
  - `{ track }` returns only what CHANGED since your last snapshot with the same key —
    `page.snapshotForAI({ track: "main" })` after an interaction. The first tracked call returns the
    full tree to set the baseline; later calls (this step or a future one) return just the diff in
    both `full` and `incremental`. Tracking resets on a full page load. Best AFTER an interaction, to
    see what it did.
- `timeout` bounds the walk. Don't pass `depth` — a shallow snapshot silently omits elements,
  causing avoidable fallback to screenshots or full HTML.
- `page.locator("aria-ref=e12")` works for an immediate action in the same script only — refs go
  stale across steps and after navigations. Prefer re-deriving a semantic selector.
