// "Let the DOM settle" quiescence detector, plus the per-INTERACTION ("fast")
// settle budgets. Shared between two call sites that both need to wait out a
// DOM rebuild an interaction just triggered, before the next interaction
// resolves its target:
//   - `browser-manager.ts`'s `settleActivePage(browserName, { fast: true })`,
//     invoked via a hostCall after every `humanClick` / `humanFill` /
//     `setInputFiles` (wired in `quickjs-sandbox.ts`'s `augmentPage`).
//   - This forked client's own `Locator.check` / `selectOption` / `uncheck` /
//     `dragTo` (`client/locator.ts`), which augmentPage does NOT wrap — they
//     settle themselves directly through `this._frame`, reaching the exact
//     same real Playwright `Page` browser-manager.ts holds (the sandbox's
//     Frame/Page channel round-trips, in-process, to the SAME
//     `preLaunchedBrowser` — see `quickjs-sandbox.ts`'s `HostBridge` wiring,
//     which hands the dispatcher the daemon's real `BrowserEntry.browser`).
//
// Kept isomorphic (no Node built-ins, no imports) so esbuild's neutral-
// platform sandbox-client bundle (`bundle-sandbox-client.ts`) can include it
// unmodified alongside the daemon's own Node build.

// Shared "go quiet" window: how long the DOM must be free of non-overlay
// mutations before quiescence is declared. Used by every settle variant
// (step barrier and fast/per-interaction alike).
export const SETTLE_QUIET_MS = 400;

// Bounds for the per-interaction settle. Tighter than the step-end barrier's
// budgets (see `browser-manager.ts`'s STEP_SETTLE_*) because this runs on
// EVERY humanClick/humanFill/setInputFiles/check/selectOption/uncheck/dragTo —
// its worst case must stay small. The quiescence check still resolves as soon
// as the DOM goes quiet for SETTLE_QUIET_MS, so a gesture with no side effects
// adds negligible latency regardless of the ceiling.
export const FAST_SETTLE_LOAD_MS = 1500;
export const FAST_SETTLE_NETWORK_MS = 1000;
export const FAST_SETTLE_QUIESCENCE_MS = 1200;

// DOM-mutation quiescence, built as a STRING for `page.evaluate` / `Frame.
// evaluate` (both the daemon's TS build and the forked client's `evaluate`
// take a plain expression string here — no DOM lib needed to construct it).
// Resolves once the DOM has been free of non-overlay mutations for quietMs,
// or after ceilingMs regardless. Canary's own cursor/ripple/caption/vignette
// overlays are ignored so their animations don't read as page activity.
export const buildDomQuiescenceJs = (
  quietMs: number,
  ceilingMs: number
): string => `
  new Promise((resolve) => {
    const isOverlay = (node) => {
      let el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
      while (el) {
        const t = el.tagName;
        if (t === "CANARY-VIRTUAL-CURSOR" || t === "CANARY-CLICK-RIPPLE" || t === "CANARY-CAPTION" || t === "CANARY-VIGNETTE") {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    };
    let quiet;
    const finish = () => { observer.disconnect(); clearTimeout(hard); clearTimeout(quiet); resolve(); };
    const bump = () => { clearTimeout(quiet); quiet = setTimeout(finish, ${quietMs}); };
    const observer = new MutationObserver((records) => {
      for (const r of records) { if (!isOverlay(r.target)) { bump(); return; } }
    });
    observer.observe(document.documentElement, { attributes: true, characterData: true, childList: true, subtree: true });
    const hard = setTimeout(finish, ${ceilingMs});
    bump();
  })
`;

export const FAST_SETTLE_DOM_QUIESCENCE_JS = buildDomQuiescenceJs(
  SETTLE_QUIET_MS,
  FAST_SETTLE_QUIESCENCE_MS
);
