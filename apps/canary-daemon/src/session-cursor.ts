// Virtual cursor overlay for session recordings.
//
// Playwright drives the page through CDP, so the OS cursor never appears in
// video or screenshots — a recording shows elements reacting to invisible
// input. This context init script renders a synthetic cursor that follows the
// trusted mouse events Playwright dispatches, plus a ripple animation on every
// mousedown, making recorded interactions legible to a human reviewer.
//
// Design constraints:
// - Runs in EVERY frame (mouse events fire only in the frame under the
//   pointer, with frame-local client coordinates). Only the top frame shows
//   the cursor eagerly — an eager cursor in every ad/embed iframe would draw
//   multiple cursors; subframes reveal theirs on first pointer event.
// - Must never affect the page: custom (unknown) element names so page CSS
//   selectors don't match, `pointer-events: none`, `position: fixed`, and
//   `aria-hidden` so the overlay is invisible to snapshotForAI / ARIA
//   snapshots and assistive queries.
// - Always visible and animated: the cursor glides between positions on a CSS
//   transform transition (retargeting mid-flight stays smooth), starts at the
//   position persisted in sessionStorage (continuity across navigations) or
//   the viewport center, and re-creates itself if a SPA wipes the DOM.
// - document.open() (setContent) removes window listeners but keeps window
//   properties, so installation re-arms on an interval instead of trusting
//   the install guard.
// Duration of the cursor's glide transition. Shared with the sandbox so the
// human-interaction helpers (page.humanClick / humanFill) can wait for the
// cursor to actually arrive before pressing — otherwise the click lands while
// the cursor is still mid-flight and the recording reads as a teleport.
export const CURSOR_GLIDE_MS = 600;

export const SESSION_CURSOR_SCRIPT = `(() => {
  if (window.__canaryCursor) {
    return;
  }
  const POS_KEY = '__canaryCursorPos';
  // Persist hidden across the re-arm interval and same-origin navigations so a
  // takeover keeps the cursor hidden even if the page reloads mid-takeover.
  const HIDE_KEY = '__canaryCursorHidden';
  let startHidden = false;
  try {
    startHidden = sessionStorage.getItem(HIDE_KEY) === '1';
  } catch {
    // storage unavailable — default visible
  }
  // \`driving\`: the cursor only tracks input while an agent helper is driving it
  // (set around humanClick/humanFill). Real user mouse moves — which are trusted
  // DOM events indistinguishable from Playwright's — are ignored otherwise, so
  // the cursor never chases the user's pointer outside a deliberate action.
  // \`hidden\`: suppressed entirely during a manual takeover.
  const state = {
    cursor: null,
    driving: false,
    glyph: 'arrow',
    hidden: startHidden,
    pressed: false,
    x: null,
    y: null,
  };
  window.__canaryCursor = state;

  const SIZE = 28;
  const GLIDE = 'transform ${CURSOR_GLIDE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)';

  const ARROW_SVG =
    '<svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 1.8 L3 18.6 L7.6 14.7 L10.4 20.9 L13.3 19.6 L10.5 13.5 L16.2 12.9 Z"' +
    ' fill="#111111" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke"/></svg>';
  // Classic pointing-hand glyph, shown over links and anything the page styles
  // as clickable (computed cursor: pointer).
  const HAND_SVG =
    '<svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M9.2 3.1a1.3 1.3 0 0 1 2.6 0v7.1h.7v-1a1.2 1.2 0 0 1 2.4 0v1.3h.7v-.8a1.2 1.2 0 0 1 2.4 0v1.5h.6v-.5a1.1 1.1 0 0 1 2.2 0v4.6c0 1-.2 1.6-.6 2.4l-1.3 2.6c-.3.6-.9 1-1.6 1h-5.5c-.6 0-1.2-.3-1.5-.8l-3.3-4.6c-.4-.6-.3-1.4.2-1.9.6-.5 1.4-.5 1.9.1l1.1 1.2z"' +
    ' fill="#111111" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round" paint-order="stroke"/></svg>';
  // I-beam, shown over text fields (computed cursor: text). White halo under a
  // black bar so it stays legible on any background, matching the other glyphs.
  const TEXT_SVG =
    '<svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M9 4 H15 M12 4 V20 M9 20 H15" fill="none" stroke="#ffffff"' +
    ' stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" paint-order="stroke"/>' +
    '<path d="M9 4 H15 M12 4 V20 M9 20 H15" fill="none" stroke="#111111"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" paint-order="stroke"/></svg>';

  function loadPos() {
    try {
      const raw = sessionStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          return p;
        }
      }
    } catch {
      // storage unavailable (sandboxed frame, data: URL) — fall through
    }
    return null;
  }

  function savePos(x, y) {
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
    } catch {
      // best effort
    }
  }

  function transformFor(x, y) {
    // Arrow/hand hotspot is the glyph tip near the box's top-left, so the box
    // sits at (x,y). The I-beam's hotspot is its centre, so shift the box
    // up-left by half its size to centre it on (x,y).
    const center = state.glyph === 'text' ? ' translate(-50%,-50%)' : '';
    const scale = state.pressed ? ' scale(0.85)' : '';
    return 'translate(' + x + 'px,' + y + 'px)' + center + scale;
  }

  function ensureCursor() {
    let el = state.cursor;
    if (el && el.isConnected) {
      return el;
    }
    const host = document.documentElement;
    if (!host) {
      return null;
    }
    if (state.x === null) {
      const stored = loadPos();
      state.x = stored ? stored.x : Math.round(window.innerWidth / 2);
      state.y = stored ? stored.y : Math.round(window.innerHeight / 2);
    }
    el = document.createElement('canary-virtual-cursor');
    el.setAttribute('aria-hidden', 'true');
    el.dataset.turboPermanent = true;
    // Created at its resting position with NO transition so a (re)install
    // never shows a fly-in from the corner; the glide is enabled on the next
    // frame, once the initial transform has painted.
    el.style.cssText =
      'position:fixed;left:0;top:0;width:' + SIZE + 'px;height:' + SIZE + 'px;' +
      'display:' + (state.hidden ? 'none' : 'block') + ';' +
      'pointer-events:none;z-index:2147483647;will-change:transform;' +
      'transform:' + transformFor(state.x, state.y) + ';';
    el.innerHTML = svgFor(state.glyph);
    host.appendChild(el);
    state.cursor = el;
    requestAnimationFrame(() => {
      el.style.transition = GLIDE;
    });
    return el;
  }

  function moveTo(x, y) {
    state.x = x;
    state.y = y;
    savePos(x, y);
    const el = ensureCursor();
    if (el) {
      el.style.transform = transformFor(x, y);
    }
  }

  // Hide/show the cursor (used to suppress it during a manual takeover, where
  // the user drives with their own pointer). Persisted so a re-arm or a
  // same-origin navigation mid-takeover keeps it hidden.
  function setHidden(value) {
    state.hidden = value;
    try {
      sessionStorage.setItem(HIDE_KEY, value ? '1' : '0');
    } catch {
      // best effort
    }
    const el = state.cursor;
    if (el && el.isConnected) {
      el.style.display = value ? 'none' : 'block';
    }
  }
  state.setHidden = setHidden;

  function svgFor(glyph) {
    if (glyph === 'hand') {
      return HAND_SVG;
    }
    if (glyph === 'text') {
      return TEXT_SVG;
    }
    return ARROW_SVG;
  }

  // Realistic glyph chosen from the element's computed cursor: an I-beam over
  // text fields (cursor:text), a hand over links/clickables (cursor:pointer),
  // an arrow elsewhere. Reading the resolved cursor (not the tag) covers native
  // controls and anything the page restyles.
  function glyphFor(el) {
    try {
      if (!(el instanceof Element)) {
        return 'arrow';
      }
      const c = getComputedStyle(el).cursor;
      if (c === 'text' || c === 'vertical-text') {
        return 'text';
      }
      if (c === 'pointer') {
        return 'hand';
      }
      return 'arrow';
    } catch {
      return 'arrow';
    }
  }

  function setGlyph(glyph) {
    if (state.glyph === glyph) {
      return;
    }
    state.glyph = glyph;
    if (state.cursor && state.cursor.isConnected) {
      state.cursor.innerHTML = svgFor(glyph);
      // The I-beam carries a different hotspot offset, so re-apply the transform.
      if (state.x !== null) {
        state.cursor.style.transform = transformFor(state.x, state.y);
      }
    }
  }

  // Re-evaluate the glyph for whatever now sits under the pointer, so it tracks
  // page changes that happen WITHOUT mouse movement (content loads, a menu
  // opens, navigation) — not just on mousemove.
  function refreshGlyph() {
    if (state.x === null || !isTopFrame) {
      return;
    }
    try {
      const el = document.elementFromPoint(state.x, state.y);
      if (el) {
        setGlyph(glyphFor(el));
      }
    } catch {
      // elementFromPoint can throw on a detached document — ignore.
    }
  }

  function ripple(x, y) {
    const host = document.documentElement;
    if (!host) {
      return;
    }
    const el = document.createElement('canary-click-ripple');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'position:fixed;width:44px;height:44px;display:block;border-radius:50%;' +
      'pointer-events:none;z-index:2147483646;' +
      'border:3px solid rgba(255,64,129,0.9);background:rgba(255,64,129,0.25);' +
      'left:' + x + 'px;top:' + y + 'px;' +
      'transform:translate(-50%,-50%) scale(0.3);opacity:0;';
    host.appendChild(el);
    try {
      const animation = el.animate(
        [
          { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 1 },
          { transform: 'translate(-50%,-50%) scale(1.4)', opacity: 0 },
        ],
        { duration: 450, easing: 'ease-out' }
      );
      animation.onfinish = () => el.remove();
      // Fallback removal in case onfinish never fires (e.g. display:none tab).
      setTimeout(() => el.remove(), 800);
    } catch {
      el.remove();
    }
  }

  const opts = { capture: true, passive: true };
  // Only track input the agent is driving (driving === true, set around
  // humanClick/humanFill). User mouse moves/clicks are trusted DOM events the
  // page can't tell apart from Playwright's, so ignoring them when not driving
  // keeps the cursor from chasing the user's real pointer.
  const onMove = (e) => {
    if (!state.driving) {
      return;
    }
    setGlyph(glyphFor(e.target));
    moveTo(e.clientX, e.clientY);
  };
  const onDown = (e) => {
    if (!state.driving) {
      return;
    }
    state.pressed = true;
    setGlyph(glyphFor(e.target));
    moveTo(e.clientX, e.clientY);
    ripple(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    if (!state.driving) {
      return;
    }
    state.pressed = false;
    moveTo(e.clientX, e.clientY);
  };

  const isTopFrame = (() => {
    try {
      return window === window.top;
    } catch {
      return false;
    }
  })();

  function arm() {
    window.addEventListener('mousemove', onMove, opts);
    window.addEventListener('mousedown', onDown, opts);
    window.addEventListener('mouseup', onUp, opts);
    // Keep the cursor on screen at all times in the top frame, including
    // before any input and after a SPA wipes the DOM. Subframes stay lazy.
    if (isTopFrame) {
      ensureCursor();
      refreshGlyph();
    }
  }
  arm();
  // document.open() (used by setContent) wipes every window listener but
  // keeps window properties — so the install guard above would leave a dead
  // overlay. Re-arming is a no-op while listeners exist (same fn reference)
  // and restores them after a wipe.
  setInterval(arm, 500);
  // Track page changes under a stationary pointer. One hit-test per tick is
  // cheap, and the timer lives on window, which document.open() preserves.
  setInterval(refreshGlyph, 250);
})();`;
