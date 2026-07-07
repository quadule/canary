# Proposal: expose the step-end settle to sandbox scripts (`page.waitForSettled()`)

Status: **proposal — not implemented.** Touches the daemon↔sandbox runtime; needs maintainer review
before shipping. Filed from a QA post-mortem where a Stimulus `data-action="form#build"` rebuild
detached an element mid-step and threw "Element is not attached to the DOM" (see the rebuild rule in
`docs/snippets/rule-visible-interaction.md`).

## Problem

Canary settles the page (document load + bounded network-idle + DOM-mutation quiescence) at the END
of every step, but a **sandbox script has no way to invoke that settle mid-step**. When a
non-navigating interaction (a radio/checkbox/select wired to a Stimulus/Turbo controller) rebuilds a
region of the DOM, the script's only recourse today is to split the flow into more steps or hand-roll
`waitForSelector({state:"attached"})` / `waitForResponse` per dependent element. A first-class
`await page.waitForSettled()` would let a script wait for the same three-phase quiescence the daemon
already computes, without ending the step.

## Where the pieces already are

- **Settle implementation:** `settleActivePage(browserName)` at
  `apps/canary-daemon/src/browser-manager.ts:548-574` — phase 1 `waitForLoadState("load")` (cap
  `STEP_SETTLE_LOAD_MS`), phase 2 `waitForLoadState("networkidle")` (cap `STEP_SETTLE_NETWORK_MS`),
  phase 3 the injected `MutationObserver` string `STEP_SETTLE_DOM_QUIESCENCE_JS`
  (`browser-manager.ts:13-51`), which ignores Canary's own overlay elements so cursor/caption
  animation doesn't read as page activity. All phases are bounded and swallow errors so settling
  never fails a step.
- **Step-end invocation:** `apps/canary-daemon/src/daemon.ts:284-291`.
- **Where a `page.*` method is registered for the sandbox:** `augmentPage(page)` in
  `apps/canary-daemon/src/sandbox/quickjs-sandbox.ts:727` — the single place `page.humanClick`,
  `page.waitForURLChange`, `page.reveal`, etc. are assigned onto the forked-client page.

## Proposed change

Add a `page.waitForSettled(opts?)` method in `augmentPage` (`quickjs-sandbox.ts:727`). Two viable
implementations, maintainer to choose:

1. **Reuse `settleActivePage`.** Bridge the sandbox to the daemon's `BrowserManager.settleActivePage`
   (the sandbox already has a daemon bridge for other operations). Cleanest — single source of truth
   for the quiescence logic — but requires wiring the call through the bridge.
2. **Inline the three phases** in `augmentPage`, since it closes over the real forked `page`. This
   duplicates the phase sequence and requires exporting `STEP_SETTLE_DOM_QUIESCENCE_JS` and the
   `STEP_SETTLE_*` constants from `browser-manager.ts` (they are module-private today). Simpler to
   wire, but a second copy of the quiescence constant to keep in sync.

Option 1 is preferred if the bridge cost is acceptable. Suggested signature:
`page.waitForSettled({ loadTimeout?, networkTimeout?, quietMs?, maxMs? })`, all defaulting to the
`STEP_SETTLE_*` constants, and (like the daemon path) never throwing — it resolves on quiescence or
on hitting the caps.

## Related (item 6): optional page-level `ariaSnapshot`

Not required. Locator-level `ariaSnapshot()` ALREADY works in the fork
(`apps/canary-daemon/src/sandbox/forked-client/src/client/locator.ts:404-411`) — it is simply
undocumented; it is now documented in `docs/snippets/api-snapshot.md`. If a page-level convenience is
ever wanted, it would be registered at the same `augmentPage` site (`quickjs-sandbox.ts:727`),
delegating to the existing `snapshotForAI` internals or `document`-root locator. No behavior change is
needed to make the current recommendation ("scoped `locator.ariaSnapshot()` for targeted checks,
`snapshotForAI` for whole-page first looks with `[ref=eN]`") work.
