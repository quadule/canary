- Every recorded click and text entry goes through the human helpers
  `page.humanClick(target)` / `page.humanFill(target, text)` (`target` is a selector string or a
  locator) — this is the default, not an option. Do NOT use raw `page.click` / `locator.click` /
  `page.fill` for a recorded action. The helpers reveal the element (scroll it into view), glide
  the on-screen cursor onto it and let it settle, then act through real input — a true click, and
  for fills a focus-then-type that sends real key events. That cursor-settling beat is the point:
  a bare `locator.click()` moves and presses in the same instant, so on camera the click lands
  before the cursor has visibly arrived. (Gestures the helpers don't cover — `hover`, keyboard
  `press`, `selectOption`, `check`/`uncheck`, drag — use the normal locator methods, still on a
  revealed element. `selectOption`/`check`/`uncheck`/`dragTo` still settle the page after acting on
  their own, even called directly on a `Locator` — see the DOM-rebuild note below.)
- ALWAYS reveal an element before interacting — no exceptions; the recording must show every
  interaction a viewer is asked to trust. The helpers scroll to the target but cannot reveal an
  element hidden behind collapsed UI — if
  it lives inside a closed menu, dropdown, accordion, tab, or unopened modal, open that container
  first, then interact — in the SAME step. A toggle-opened container (a menu/dropdown) STAYS open
  across steps, so if you opened it in an earlier step (e.g. to snapshot and find the item), do NOT
  click the toggle again to "open" it — that CLOSES it; just click the item. Any
  `scrollIntoViewIfNeeded` / `page.isVisible(sel)` checks fold into the interaction's own script —
  keep them out of the step list as bookkeeping.
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
- When several `<dialog>` elements coexist in the DOM at once (a modal, a drawer, …), don't rely
  on `isVisible()` / `isHidden()` to pick the active one — frameworks often show/hide a `<dialog>`
  with CSS while it stays `open` in the DOM, so Playwright's visibility heuristic can report the
  truly-shown one as `false`. Identify it by content instead: `page.locator("dialog", { hasText:
  "…" })` / `page.getByRole("dialog", { name: "…" })`, or scope straight to a known descendant
  inside it — rather than testing `.isVisible()` across every match and trusting the boolean.
- Cascading-disclosure UI — a menu / split button that opens a list of item buttons, each of which
  opens something more — does NOT tell you in advance whether an item reveals an INLINE section
  grafted into the page or a drawer/modal, and that can differ per item and change between releases.
  So after EACH click in the chain, observe immediately — prefer `snapshotForAI({ track: "main" })`
  so an empty diff instantly tells you the click did nothing (wrong element, or a menu item whose
  menu had already closed) versus showing you exactly what appeared. Don't pre-commit to hunting a
  `<dialog>`: a `dialog`-scoped snapshot after an inline disclosure finds nothing and sends you
  chasing a modal that never opened. The reveal may need a beat to mount or animate, so then wait on
  the concrete new element you expect (`getByRole`/`getByText` for its heading or first field), not a
  fixed sleep.
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
  interaction wait on the CONCRETE result before moving on — assert or act on the thing that
  changed (the validation message appearing, the new/required field rendering, the submit button
  flipping enabled); Playwright auto-waits when you act on it. Re-check the submit control is
  enabled right before you submit. Firing submit into a mid-validation form records a failure that
  isn't the app's fault, and a real user wouldn't do it either.
- Some non-navigating interactions REBUILD part of the DOM — choosing a radio / checkbox / dropdown
  or typing into a field can trigger a client-side rebuild (a form controller regenerating a
  dependent section, an inline-validation re-render, an htmx/React/Turbo swap) that DETACHES the
  elements it replaces, so a handle grabbed a moment earlier throws "Element is not attached to the
  DOM" when acted on next. This is handled automatically for essentially every recorded gesture:
  `humanClick`, `humanFill`, and `setInputFiles` settle the page AFTER acting (bounded network-idle
  + DOM-mutation quiescence — framework-agnostic, NOT attribute-sniffing); and `Locator.check()` /
  `.uncheck()` / `.selectOption()` / `.dragTo()` settle themselves the same way even when called
  directly on a `Locator` (not through `humanClick`), since a script can reach these without going
  through the human-interaction helpers. Either way, a rebuild the interaction triggered has
  committed before the NEXT interaction resolves its target, so back-to-back interactions no longer
  stale each other — you do NOT need to detect `data-action` / `data-controller` attributes or
  hand-split steps for this, it's automatic. Two cases still need care: (a) `hover` and keyboard
  `press` are NOT auto-settled — they rarely mutate the DOM on their own, but if one does (e.g.
  `press("Enter")` submitting a form), wait on the concrete result the same way you would after any
  submit; and (b) the rare rebuild slower than the per-interaction settle ceiling (a long
  fetch-then-swap) — if a dependent still comes back detached, make the rebuilding interaction the
  last action of its step and act on the dependents in the NEXT step (the step-end settle has a
  larger budget). Never reuse a handle grabbed before a rebuild.
- A form submit that FAILS validation usually returns HTTP 422 and re-renders the form with errors.
  In Rails/Turbo apps that comes back as a Turbo-stream rebuild, NOT a navigation. A SUCCESSFUL
  submit navigates, but a submit that MIGHT fail in place shouldn't use `humanClickAndWaitForURL` —
  it hangs to the timeout on failure. Instead `humanClick` the submit, then wait for EITHER outcome:
  the URL to change (success) OR an error/flash to appear (failure). Observe the re-rendered page. To
  FIND the errors, do NOT assume a class name: a `snapshotForAI` outline surfaces ACCESSIBILITY
  semantics, not CSS classes, and many design systems attach NO ARIA to error markup (no
  `aria-invalid`, no `role="alert"`), so the error is just an anonymous text node in the outline.
  Instead (a) search the snapshot for the message TEXT, or (b) read the DOM for the app's real error
  class — `page.$$eval(".<app-error-class>", els => els.map(e => e.textContent))`, discovering that
  class once from a failing field's `outerHTML`. Don't reach for `[aria-invalid]` / `.is-invalid` /
  `.field_with_errors`: those are Bootstrap / Rails-default markers that a design-system app commonly
  overrides or suppresses, so all three match nothing. Note that some errors attach to an
  association or the record's base, not a single field, and by design render nowhere inline — a
  generic flash banner is then the only user-visible signal.
- Verify through the surfaces a SHIPPED user sees — the on-screen flash and inline field messages.
  Do NOT click dev-only diagnostics (a "View Submitted Errors" / debug-drawer button, a `?debug=`
  panel): they don't exist in production, so reading them proves nothing about the real experience
  and reads wrong in a demo recording.
- A click timeout or `page.isVisible(sel)` returning false usually means hidden, not missing:
  snapshot, find the toggle/menu/tab that reveals the element, click that, then retry.
