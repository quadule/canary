import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_CURSOR_SCRIPT } from "./session-cursor.js";

// The init script attaches these to the page's `window` at runtime; declare them
// so the in-browser `page.evaluate` callbacks type-check against the real shape.
declare global {
  interface Window {
    __canaryCursor: {
      x: number;
      y: number;
      glyph: string;
      glide: (x: number, y: number, el?: Element) => void;
    };
    __ripples: number;
  }
}

// The virtual cursor is positioned ONLY by the agent's explicit state.glide()
// (called from the humanClick/humanFill helpers). It must never track raw mouse
// events — those are indistinguishable from the user's real pointer, so tracking
// them would make it chase a stray move. These tests pin that contract against a
// real browser with the init script injected the same way the daemon injects it.
describe("session cursor", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function pageWithCursor() {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
    });
    await context.addInitScript(SESSION_CURSOR_SCRIPT);
    const page = await context.newPage();
    await page.setContent(
      '<a id="link" href="#" style="position:absolute;left:380px;top:280px">a link</a>'
    );
    await page.waitForFunction(() => Boolean(window.__canaryCursor));
    return { context, page };
  }

  it("ignores a mouse move it was not told to make", async () => {
    const { context, page } = await pageWithCursor();
    try {
      const before = await page.evaluate(() => ({
        x: window.__canaryCursor.x,
        y: window.__canaryCursor.y,
      }));
      await page.mouse.move(120, 140);
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({
        x: window.__canaryCursor.x,
        y: window.__canaryCursor.y,
      }));
      // The cursor stayed put — it did not follow the pointer to (120, 140).
      expect(after).toEqual(before);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("glides onto the target, picks the glyph, and ripples once on the click", async () => {
    const { context, page } = await pageWithCursor();
    try {
      // Count ripple elements as they are created (the animation removes itself,
      // so a later DOM query could miss it).
      await page.evaluate(() => {
        window.__ripples = 0;
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeName === "CANARY-CLICK-RIPPLE") {
                window.__ripples += 1;
              }
            }
          }
        }).observe(document.documentElement, { childList: true });
      });

      const center = await page.evaluate(() => {
        const el = document.getElementById("link");
        if (!el) {
          throw new Error("test fixture missing #link");
        }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // glide sets state.x/y and the glyph synchronously (the CSS transition
        // is cosmetic), so we can read them straight away.
        window.__canaryCursor.glide(x, y, el);
        return { x: Math.round(x), y: Math.round(y) };
      });

      const landed = await page.evaluate(() => ({
        x: Math.round(window.__canaryCursor.x),
        y: Math.round(window.__canaryCursor.y),
        glyph: window.__canaryCursor.glyph,
      }));
      expect(Math.abs(landed.x - center.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(landed.y - center.y)).toBeLessThanOrEqual(2);
      // A link computes cursor:pointer → the hand glyph.
      expect(landed.glyph).toBe("hand");

      // The real click that follows fires the armed one-shot ripple.
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => window.__ripples)).toBe(1);

      // The arm is one-shot: a further click with no fresh glide must not ripple,
      // so a stray user click between actions can't paint a phantom ripple.
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => window.__ripples)).toBe(1);
    } finally {
      await context.close();
    }
  }, 30_000);
});
