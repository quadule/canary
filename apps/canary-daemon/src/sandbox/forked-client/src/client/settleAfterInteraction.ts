import {
  FAST_SETTLE_DOM_QUIESCENCE_JS,
  FAST_SETTLE_LOAD_MS,
  FAST_SETTLE_NETWORK_MS,
} from "../utils/isomorphic/domSettle";

import type { Frame } from "./frame";

// Bounded, best-effort "let the page settle" run AFTER a Locator/ElementHandle
// gesture that mutates the page (check, uncheck, selectOption, dragTo,
// click) — the framework-agnostic fix for a rebuild (Stimulus/Turbo/React/
// htmx, anything) detaching an element a NEXT action was about to touch.
// These gestures don't go through the daemon's `augmentPage` wrapper (only
// `humanFill`/`setInputFiles` do — see `quickjs-sandbox.ts`), so they settle
// themselves here, directly through `this._frame`. That still reaches the
// exact same real Playwright page `browser-manager.ts`'s `settleActivePage`
// operates on: the sandbox's protocol channel round-trips, in-process, to a
// dispatcher wrapping the daemon's own `preLaunchedBrowser` (see
// `quickjs-sandbox.ts` / `host-bridge.ts`). Budgets and quiescence JS are
// shared with `settleActivePage`'s fast path via `utils/isomorphic/
// domSettle.ts`.
//
// NOTE on a real (cross-document or History-API) navigation caused by the
// gesture: we investigated adding a pre-action "navigated"/"request" event
// listener here, registered BEFORE the action, to guard against
// `waitForLoadState("load")` being checked too early — before the browser
// had even started the new navigation — and resolving as a stale no-op
// against the OLD frame. That would mirror how `page.humanClickAndWaitForURL`
// avoids missing a same-tick navigation. Empirically, though, that race does
// NOT reproduce through this client's `Locator.click()` / `Frame.click()`:
// real Playwright's own click() dispatch already blocks until a navigation
// IT triggered has committed — measured directly, both for a same-tick
// `<a href>` nav and for a DEFERRED nav (a click handler that calls
// `location.assign` from a `setTimeout(0)` callback, i.e. NOT a direct
// synchronous side effect of the click event). Both made `click()` itself
// take as long as the destination's response time (~570ms for a
// ~500ms-delayed response) vs. ~20ms for a non-navigating click on the same
// page — click() already waits the navigation out, with no extra code here.
// So there's nothing to guard against for the navigation case specifically;
// the load/networkidle waits below are cheap insurance (near-instant no-ops
// in the common case, since click() already left the frame settled) rather
// than the actual fix for anything we could reproduce.
//
// Every wait is capped and failures are swallowed — settling must never fail
// the underlying gesture.
export async function settleAfterInteraction<T>(
  frame: Frame,
  performAction: () => Promise<T>
): Promise<T> {
  const result = await performAction();
  await frame
    .waitForLoadState("load", { timeout: FAST_SETTLE_LOAD_MS })
    .catch(() => undefined);
  await frame
    .waitForLoadState("networkidle", { timeout: FAST_SETTLE_NETWORK_MS })
    .catch(() => undefined);
  await frame.evaluate(FAST_SETTLE_DOM_QUIESCENCE_JS).catch(() => undefined);
  return result;
}
