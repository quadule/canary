import { readFile } from "node:fs/promises";
import util from "node:util";

import type { Page } from "playwright";

import type { BrowserManager } from "../browser-manager.js";
import { CURSOR_GLIDE_MS } from "../session-cursor.js";
import {
  ensureCanaryTempDir,
  readCanaryTempFile,
  writeCanaryTempFile,
} from "../temp-files.js";
import { HostBridge } from "./host-bridge.js";
import { type QuickJSConsoleLevel, QuickJSHost } from "./quickjs-host.js";

const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const WAIT_FOR_OBJECT_ATTEMPTS = 1000;
// The human-interaction helpers move the pointer to the target and wait this
// long before pressing, so the virtual cursor finishes gliding into place and
// then visibly rests on the target for a beat before the click — rather than
// teleporting. The cursor's glide duration plus a 200ms post-arrival pause.
const CURSOR_SETTLE_MS = CURSOR_GLIDE_MS + 200;

// Upper bound on the animated scroll that reveals an off-screen target. Playwright's
// scrollIntoViewIfNeeded jumps instantly (invisible on camera), so before it we
// smooth-scroll the element into view and wait for that to settle — capped here so
// a page that ignores `behavior:smooth` (CSS scroll-behavior / reduced motion) or
// an unusually long scroll can't stall the step.
const SCROLL_REVEAL_CAP_MS = 1500;

// Per-character delay for humanFill so typing is visible on camera rather than
// appearing all at once. Kept well under the video condenser's freeze floor
// (FREEZE_MIN_SEC, 0.4s) so the gaps between keystrokes never read as a still
// stretch and get trimmed.
const TYPE_DELAY_MS = 90;

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve sandbox-client.js: next to the running script (production), or in dist/ (development)
function findBundlePath(): string {
  const candidates = [
    fileURLToPath(new URL("./sandbox-client.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/sandbox-client.js", import.meta.url)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  throw new Error(
    `Failed to find sandbox-client.js. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}
const BUNDLE_PATH = findBundlePath();
const TRANSPORT_RECEIVE_GLOBAL = "__transport_receive";

let bundleCodePromise: Promise<string> | undefined;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : util.inspect(arg, {
            colors: false,
            depth: 6,
            compact: 3,
            breakLength: Number.POSITIVE_INFINITY,
          })
    )
    .join(" ");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function getSandboxClientBundleCode(): Promise<string> {
  bundleCodePromise ??= readFile(BUNDLE_PATH, "utf8").catch(
    (error: unknown) => {
      bundleCodePromise = undefined;
      const message =
        error instanceof Error
          ? error.message
          : "Sandbox client bundle could not be read";
      throw new Error(
        `Failed to load sandbox client bundle at ${BUNDLE_PATH}: ${message}`
      );
    }
  );
  return bundleCodePromise;
}

function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }

  return `${timeoutMs}ms`;
}

function createScriptTimeoutError(timeoutMs: number): Error {
  const error = new Error(
    `Script timed out after ${formatTimeoutDuration(timeoutMs)} and was terminated.`
  );
  error.name = "ScriptTimeoutError";
  return error;
}

function createGuestScriptTimeoutErrorSource(timeoutMs: number): string {
  const message = JSON.stringify(createScriptTimeoutError(timeoutMs).message);
  return `(() => {
    const error = new Error(${message});
    error.name = "ScriptTimeoutError";
    return error;
  })()`;
}

function wrapScriptWithWallClockTimeout(
  script: string,
  timeoutMs?: number
): string {
  if (timeoutMs === undefined) {
    return script;
  }

  return `
    (() => {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(${createGuestScriptTimeoutErrorSource(timeoutMs)});
        }, ${timeoutMs});

        Promise.resolve()
          .then(() => (${script}))
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timeoutId);
          });
      });
    })()
  `;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value;
}

function toServerImpl<T>(clientObject: unknown, label: string): T {
  const connection = (
    clientObject as { _connection?: { toImpl?: (value: unknown) => unknown } }
  )._connection;
  const toImpl = connection?.toImpl;
  if (typeof toImpl !== "function") {
    throw new Error(`${label} does not expose a server implementation`);
  }

  const impl = toImpl(clientObject);
  if (!impl) {
    throw new Error(`${label} could not be mapped to a server implementation`);
  }

  return impl as T;
}

function extractGuid(page: Page): string {
  const guid = toServerImpl<{ guid?: unknown }>(page, "Playwright page").guid;
  if (typeof guid !== "string" || guid.length === 0) {
    throw new Error("Playwright page did not expose a guid");
  }

  return guid;
}

function decodeSandboxFilePayload(
  value: unknown,
  label: string
): string | Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  const encoding = "encoding" in value ? value.encoding : undefined;
  const data = "data" in value ? value.data : undefined;
  if (
    (encoding !== "utf8" && encoding !== "base64") ||
    typeof data !== "string"
  ) {
    throw new TypeError(
      `${label} must include a valid encoding and string data`
    );
  }

  if (encoding === "utf8") {
    return data;
  }

  return Buffer.from(data, "base64");
}

interface QuickJSSandboxOptions {
  browserName: string;
  manager: BrowserManager;
  memoryLimitBytes?: number;
  onStderr: (data: string) => void;
  onStdout: (data: string) => void;
  timeoutMs?: number;
}

export class QuickJSSandbox {
  readonly #options: QuickJSSandboxOptions;
  readonly #anonymousPages = new Set<Page>();
  readonly #pendingHostOperations = new Set<Promise<void>>();
  readonly #transportInbox: string[] = [];

  #asyncError?: Error;
  #host?: QuickJSHost;
  #hostBridge?: HostBridge;
  #flushPromise?: Promise<void>;
  #disposed = false;
  #initialized = false;

  constructor(options: QuickJSSandboxOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    this.#assertAlive();
    if (this.#initialized) {
      return;
    }

    try {
      await ensureCanaryTempDir();

      this.#host = await QuickJSHost.create({
        memoryLimitBytes:
          this.#options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
        cpuTimeoutMs: this.#options.timeoutMs,
        hostFunctions: {
          getPage: (name) => this.#getPage(name),
          newPage: () => this.#newPage(),
          listPages: () =>
            this.#options.manager.listPages(this.#options.browserName),
          closePage: (name) => this.#closePage(name),
          saveScreenshot: (name, data) => this.#writeTempFile(name, data),
          writeFile: (name, data) => this.#writeTempFile(name, data),
          readFile: (name) => this.#readTempFile(name),
        },
        onConsole: (level, args) => {
          this.#routeConsole(level, args);
        },
        onDrain: () => this.#drainAsyncOps(),
        onTransportSend: (message) => {
          this.#handleTransportSend(message);
        },
      });

      this.#host.executeScriptSync(
        `
          const __performanceOrigin = Date.now();
          const __base64Alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

          const __encodeBase64 = (bytes) => {
            let result = "";
            for (let index = 0; index < bytes.length; index += 3) {
              const chunk =
                (bytes[index] << 16) |
                ((bytes[index + 1] ?? 0) << 8) |
                (bytes[index + 2] ?? 0);
              result += __base64Alphabet[(chunk >> 18) & 63];
              result += __base64Alphabet[(chunk >> 12) & 63];
              result += index + 1 < bytes.length ? __base64Alphabet[(chunk >> 6) & 63] : "=";
              result += index + 2 < bytes.length ? __base64Alphabet[chunk & 63] : "=";
            }
            return result;
          };

          const __decodeBase64 = (base64) => {
            const normalized = String(base64).replace(/\\s+/g, "");
            const output = [];
            for (let index = 0; index < normalized.length; index += 4) {
              const a = __base64Alphabet.indexOf(normalized[index] ?? "A");
              const b = __base64Alphabet.indexOf(normalized[index + 1] ?? "A");
              const c =
                normalized[index + 2] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 2] ?? "A");
              const d =
                normalized[index + 3] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 3] ?? "A");
              const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
              output.push((chunk >> 16) & 255);
              if (c !== 64) {
                output.push((chunk >> 8) & 255);
              }
              if (d !== 64) {
                output.push(chunk & 255);
              }
            }
            return new Uint8Array(output);
          };

          globalThis.URL ??= class URL {
            constructor(value, base) {
              this.href = base === undefined ? String(value) : String(base) + String(value);
            }

            toJSON() {
              return this.href;
            }

            toString() {
              return this.href;
            }
          };

          globalThis.Buffer ??= class Buffer extends Uint8Array {
            constructor(value, byteOffset, length) {
              if (typeof value === "number") {
                super(value);
                return;
              }
              if (value instanceof ArrayBuffer) {
                super(value, byteOffset, length);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                super(value.buffer, value.byteOffset, value.byteLength);
                return;
              }
              super(value);
            }

            static from(value, encodingOrOffset, length) {
              if (typeof value === "string") {
                if (encodingOrOffset !== undefined && encodingOrOffset !== "base64") {
                  throw new Error("QuickJS Buffer only supports base64 string input");
                }
                return new Buffer(__decodeBase64(value));
              }
              if (value instanceof ArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
              }
              if (ArrayBuffer.isView(value)) {
                return new Buffer(
                  value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
                );
              }
              if (Array.isArray(value)) {
                return new Buffer(value);
              }
              throw new TypeError("Unsupported Buffer.from input");
            }

            toString(encoding) {
              if (encoding === undefined || encoding === "utf8") {
                return Array.from(this)
                  .map((value) => String.fromCharCode(value))
                  .join("");
              }
              if (encoding === "base64") {
                return __encodeBase64(this);
              }
              throw new Error("QuickJS Buffer only supports utf8 and base64 output");
            }
          };

          globalThis.performance ??= {
            now: () => Date.now() - __performanceOrigin,
            timeOrigin: __performanceOrigin,
          };
          globalThis.global = globalThis;
        `,
        {
          filename: "quickjs-runtime.js",
        }
      );

      const bundleCode = await getSandboxClientBundleCode();
      const bundleFactorySource = JSON.stringify(
        `${bundleCode}\nreturn __PlaywrightClient;`
      );
      this.#host.executeScriptSync(
        `
          globalThis.__createPlaywrightClient = () => {
            return new Function(${bundleFactorySource})();
          };
        `,
        {
          filename: "sandbox-client.js",
        }
      );

      const browserEntry = this.#options.manager.getBrowser(
        this.#options.browserName
      );
      if (!browserEntry) {
        throw new Error(
          `Browser "${this.#options.browserName}" not found. It should have been created before script execution.`
        );
      }
      this.#hostBridge = new HostBridge({
        sendToSandbox: (json) => {
          this.#transportInbox.push(json);
        },
        preLaunchedBrowser: toServerImpl(
          browserEntry.browser,
          "Playwright browser"
        ),
        sharedBrowser: true,
        denyLaunch: true,
      });

      await this.#host.executeScript(
        `
          (() => {
            const hostCall = globalThis.__hostCall;
            const transportSend = globalThis.__transport_send;
            const createPlaywrightClient = globalThis.__createPlaywrightClient;

            if (typeof hostCall !== "function") {
              throw new Error("Sandbox bridge did not expose a host-call function");
            }
            if (typeof transportSend !== "function") {
              throw new Error("Sandbox bridge did not expose a transport sender");
            }
            if (typeof createPlaywrightClient !== "function") {
              throw new Error("Sandbox client bundle did not expose a Playwright client factory");
            }

            if (!delete globalThis.__hostCall) {
              globalThis.__hostCall = undefined;
            }
            if (!delete globalThis.__transport_send) {
              globalThis.__transport_send = undefined;
            }
            if (!delete globalThis.__createPlaywrightClient) {
              globalThis.__createPlaywrightClient = undefined;
            }

            const playwrightClient = createPlaywrightClient();
            const connection = new playwrightClient.Connection(playwrightClient.quickjsPlatform);
            connection.onmessage = (message) => {
              transportSend(JSON.stringify(message));
            };

            Object.defineProperty(globalThis, "${TRANSPORT_RECEIVE_GLOBAL}", {
              value: (json) => {
                connection.dispatch(JSON.parse(json));
              },
              configurable: false,
              enumerable: false,
              writable: false,
            });

            const waitForConnectionObject = async (guid, label) => {
              if (typeof guid !== "string" || guid.length === 0) {
                throw new Error(\`\${label} did not return a valid guid\`);
              }

              for (let attempt = 0; attempt < ${WAIT_FOR_OBJECT_ATTEMPTS}; attempt += 1) {
                const object = connection.getObjectWithKnownName(guid);
                if (object) {
                  return object;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
              }

              throw new Error(\`Timed out waiting for \${label} (\${guid}) in the sandbox\`);
            };

            const encodeHostFilePayload = (value) => {
              if (typeof value === "string") {
                return { encoding: "utf8", data: value };
              }
              if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return { encoding: "base64", data: Buffer.from(value).toString("base64") };
              }
              throw new TypeError(
                "File data must be a string, Buffer, Uint8Array, or ArrayBuffer",
              );
            };

            // Human-interaction helpers attached to every page handed to a
            // script. They reveal the target, glide the virtual cursor to it,
            // wait for the glide to land, then act through real input — so the
            // recording shows what a person would see. Pure wrappers over the
            // documented page/locator API; the daemon's Playwright is untouched.
            const resolveLocator = (page, target) =>
              typeof target === "string" ? page.locator(target) : target;

            // Animate an off-screen target into view so the scroll is visible on
            // camera (Playwright's scrollIntoViewIfNeeded teleports). Resolves once
            // the element stops moving — tracked via its rect, which moves no matter
            // which ancestor scrolls (an inner panel won't change window.scrollY) —
            // or when the cap elapses. A no-op when the element is already in view.
            const smoothReveal = (target) =>
              target
                .evaluate(
                  (el, capMs) =>
                    new Promise((resolve) => {
                      const inView = () => {
                        const r = el.getBoundingClientRect();
                        const m = 8;
                        return (
                          r.top >= m &&
                          r.left >= m &&
                          r.bottom <= window.innerHeight - m &&
                          r.right <= window.innerWidth - m
                        );
                      };
                      if (inView()) {
                        resolve();
                        return;
                      }
                      el.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                        inline: "center",
                      });
                      const start = performance.now();
                      let last = Number.NaN;
                      let stable = 0;
                      const tick = () => {
                        const top = Math.round(el.getBoundingClientRect().top);
                        if (top === last) {
                          stable += 1;
                        } else {
                          stable = 0;
                          last = top;
                        }
                        if (stable >= 4 || performance.now() - start > capMs) {
                          resolve();
                          return;
                        }
                        requestAnimationFrame(tick);
                      };
                      requestAnimationFrame(tick);
                    }),
                  ${SCROLL_REVEAL_CAP_MS},
                )
                .catch(() => undefined);

            const revealAndGlide = async (page, target) => {
              // Smooth-scroll for the camera, then let Playwright guarantee the
              // element is actionable (a no-op snap once smoothReveal has landed it).
              await smoothReveal(target);
              await target.scrollIntoViewIfNeeded();
              // Drive the virtual cursor explicitly: one in-page call glides it
              // onto the target's centre and arms the click ripple. No "driving"
              // flag and no extra mouse.move/boundingBox — so the cursor never
              // chases the user's real pointer and the trace isn't cluttered with
              // cursor bookkeeping. The CSS transform transition animates the move.
              const glided = await target
                .evaluate((el) => {
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 && r.height === 0) {
                    return false;
                  }
                  window.__canaryCursor?.glide(
                    r.left + r.width / 2,
                    r.top + r.height / 2,
                    el,
                  );
                  return true;
                })
                .catch(() => false);
              if (!glided) {
                return false;
              }
              await page.waitForTimeout(${CURSOR_SETTLE_MS});
              return true;
            };

            // A checkbox/radio is frequently a visually-hidden <input> with a
            // custom CSS control drawn over a <label>; clicking the input itself
            // misses (it's zero-size/invisible). When the target resolves to such
            // a hidden input, retarget the click to its label — what a real user
            // clicks. One round-trip: evaluateHandle returns the label to click,
            // or the element itself otherwise (an ElementHandle that supports the
            // scrollIntoViewIfNeeded / evaluate / click that follow).
            const resolveClickTarget = async (page, target) => {
              const locator = resolveLocator(page, target);
              const handle = await locator
                .evaluateHandle((el) => {
                  if (
                    el instanceof HTMLInputElement &&
                    (el.type === "checkbox" || el.type === "radio")
                  ) {
                    const rect = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    const hidden =
                      rect.width <= 1 ||
                      rect.height <= 1 ||
                      cs.visibility === "hidden" ||
                      cs.display === "none" ||
                      Number(cs.opacity) === 0;
                    const label = el.labels && el.labels[0];
                    if (hidden && label) {
                      return label;
                    }
                  }
                  return el;
                })
                .catch(() => null);
              return (handle && handle.asElement()) || locator;
            };

            const augmentPage = (page) => {
              if (!page || page.__canaryHuman) {
                return page;
              }
              Object.defineProperty(page, "__canaryHuman", { value: true });
              page.humanClick = async (target, options) => {
                const locator = await resolveClickTarget(page, target);
                await revealAndGlide(page, locator);
                await locator.click(options);
              };
              page.humanFill = async (target, text, options) => {
                const locator = resolveLocator(page, target);
                await revealAndGlide(page, locator);
                await locator.click();
                // Park the cursor just below the field so it doesn't sit on top
                // of the text as it's typed.
                await locator
                  .evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    window.__canaryCursor?.park(r.left + 12, r.bottom + 16);
                  })
                  .catch(() => undefined);
                await locator.fill("");
                // Type with a short per-character delay so the typing is visible
                // on camera (caller can override via options.delay).
                await locator.pressSequentially(String(text), {
                  delay: ${TYPE_DELAY_MS},
                  ...options,
                });
              };
              // Generic "let the page settle" wait — framework-agnostic. Waits
              // for the document load (a no-op once loaded) and then for the DOM
              // to stop mutating for a quiet window, bounded by a timeout. Unlike
              // networkidle it watches the DOM, not the network, so it doesn't
              // hang on long-lived connections (websockets, polling). Ignores
              // Canary's own overlays so the cursor/ripple/caption animations
              // don't count as page activity. Use after a client-side navigation
              // before snapshotting; for an action, prefer acting on the
              // destination element (Playwright auto-waits for it).
              page.waitForSettled = async (options) => {
                const quietMs =
                  options && typeof options.quietMs === "number"
                    ? options.quietMs
                    : 400;
                const timeoutMs =
                  options && typeof options.timeoutMs === "number"
                    ? options.timeoutMs
                    : 5000;
                await page.waitForLoadState("load").catch(() => undefined);
                await page
                  .evaluate(
                    (arg) =>
                      new Promise((resolve) => {
                        const isOverlay = (node) => {
                          let el =
                            node && node.nodeType === 1 ? node : node?.parentElement;
                          while (el) {
                            const t = el.tagName;
                            if (
                              t === "CANARY-VIRTUAL-CURSOR" ||
                              t === "CANARY-CLICK-RIPPLE" ||
                              t === "CANARY-CAPTION"
                            ) {
                              return true;
                            }
                            el = el.parentElement;
                          }
                          return false;
                        };
                        let quiet;
                        const finish = () => {
                          observer.disconnect();
                          clearTimeout(hard);
                          clearTimeout(quiet);
                          resolve(undefined);
                        };
                        const bump = () => {
                          clearTimeout(quiet);
                          quiet = setTimeout(finish, arg.quietMs);
                        };
                        const observer = new MutationObserver((records) => {
                          for (const r of records) {
                            if (!isOverlay(r.target)) {
                              bump();
                              return;
                            }
                          }
                        });
                        observer.observe(document.documentElement, {
                          attributes: true,
                          characterData: true,
                          childList: true,
                          subtree: true,
                        });
                        const hard = setTimeout(finish, arg.timeoutMs);
                        bump();
                      }),
                    { quietMs, timeoutMs }
                  )
                  .catch(() => undefined);
              };
              // Show a caption overlay in the page to label a section of the
              // recording for a human viewer. Non-blocking: it fades in, holds
              // for durationMs, then fades out. Cosmetic only (custom element,
              // pointer-events:none, aria-hidden) so it never affects the page
              // or snapshots. Replaces any caption already showing. The hold
              // gently breathes so the frame never reads as "still" — otherwise
              // the condense pass (which now drops every motionless stretch)
              // would collapse a caption shown over a static page.
              page.showCaption = async (text, options) => {
                const ms =
                  options && typeof options.durationMs === "number"
                    ? options.durationMs
                    : 3000;
                await page
                  .evaluate(
                    (arg) => {
                      const host = document.documentElement;
                      if (!host) {
                        return;
                      }
                      for (const prev of document.querySelectorAll(
                        "canary-caption"
                      )) {
                        prev.remove();
                      }
                      const el = document.createElement("canary-caption");
                      el.setAttribute("aria-hidden", "true");
                      el.textContent = arg.text;
                      el.style.cssText =
                        "position:fixed;left:50%;bottom:36px;" +
                        "transform:translateX(-50%) translateY(8px);" +
                        "max-width:80vw;padding:12px 20px;border-radius:10px;" +
                        "background:rgba(17,17,17,0.86);color:#fff;" +
                        "font:500 18px/1.45 system-ui,-apple-system,sans-serif;" +
                        "z-index:2147483646;pointer-events:none;white-space:pre-wrap;" +
                        "text-align:center;box-shadow:0 4px 18px rgba(0,0,0,0.35);opacity:0;";
                      host.appendChild(el);
                      const FADE = 250;
                      const hold = Math.max(0, arg.ms - FADE * 2);
                      try {
                        const fadeIn = el.animate(
                          [
                            {
                              opacity: 0,
                              transform: "translateX(-50%) translateY(8px)",
                            },
                            {
                              opacity: 1,
                              transform: "translateX(-50%) translateY(0)",
                            },
                          ],
                          { duration: FADE, easing: "ease-out", fill: "forwards" }
                        );
                        fadeIn.onfinish = () => {
                          // Whole-box opacity breathing — enough changing area
                          // per frame to clear the freeze-detector's threshold.
                          const breathe = el.animate(
                            [{ opacity: 1 }, { opacity: 0.78 }, { opacity: 1 }],
                            { duration: 1400, iterations: Number.POSITIVE_INFINITY }
                          );
                          setTimeout(() => {
                            breathe.cancel();
                            const out = el.animate(
                              [{ opacity: 1 }, { opacity: 0 }],
                              { duration: FADE, easing: "ease-in", fill: "forwards" }
                            );
                            out.onfinish = () => el.remove();
                            setTimeout(() => el.remove(), FADE + 250);
                          }, hold);
                        };
                      } catch {
                        setTimeout(() => el.remove(), arg.ms);
                      }
                    },
                    { ms, text: String(text) }
                  )
                  .catch(() => undefined);
              };
              return page;
            };

            return (async () => {
              await connection.initializePlaywright();

              const browserApi = Object.create(null);
              Object.defineProperties(browserApi, {
                getPage: {
                  value: async (name) => {
                    const guid = await hostCall("getPage", JSON.stringify([name]));
                    return augmentPage(await waitForConnectionObject(guid, \`page "\${name}"\`));
                  },
                  enumerable: true,
                },
                newPage: {
                  value: async () => {
                    const guid = await hostCall("newPage", JSON.stringify([]));
                    return augmentPage(await waitForConnectionObject(guid, "anonymous page"));
                  },
                  enumerable: true,
                },
                listPages: {
                  value: async () => {
                    return await hostCall("listPages", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                closePage: {
                  value: async (name) => {
                    await hostCall("closePage", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(browserApi);

              Object.defineProperty(globalThis, "browser", {
                value: browserApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              Object.defineProperties(globalThis, {
                saveScreenshot: {
                  value: async (buffer, name) => {
                    return await hostCall(
                      "saveScreenshot",
                      JSON.stringify([name, encodeHostFilePayload(buffer)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                writeFile: {
                  value: async (name, data) => {
                    return await hostCall(
                      "writeFile",
                      JSON.stringify([name, encodeHostFilePayload(data)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                readFile: {
                  value: async (name) => {
                    return await hostCall("readFile", JSON.stringify([name]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
              });
            })();
          })()
        `,
        {
          filename: "sandbox-init.js",
        }
      );

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
      this.#initialized = true;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async executeScript(script: string): Promise<void> {
    this.#assertInitialized();
    let executionError: unknown;

    try {
      this.#throwIfAsyncError();

      await this.#host?.executeScript(
        wrapScriptWithWallClockTimeout(script, this.#options.timeoutMs),
        {
          filename: "user-script.js",
        }
      );

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
    } catch (error) {
      executionError = error;
    }

    try {
      await this.#cleanupAnonymousPages();
    } catch (error) {
      executionError ??= error;
    }

    if (executionError) {
      throw executionError;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    await this.#cleanupAnonymousPages({
      suppressErrors: true,
    });

    this.#transportInbox.length = 0;
    this.#pendingHostOperations.clear();

    try {
      await this.#hostBridge?.dispose();
    } catch {
      // Best effort cleanup during sandbox teardown.
    } finally {
      this.#hostBridge = undefined;
      this.#host?.dispose();
      this.#host = undefined;
      this.#flushPromise = undefined;
    }
  }

  #routeConsole(level: QuickJSConsoleLevel, args: unknown[]): void {
    const line = `${formatArgs(args)}\n`;
    if (level === "warn" || level === "error") {
      this.#options.onStderr(line);
      return;
    }

    this.#options.onStdout(line);
  }

  #handleTransportSend(message: string): void {
    if (!this.#hostBridge) {
      this.#asyncError ??= new Error("Sandbox transport is not initialized");
      return;
    }

    const operation = this.#hostBridge
      .receiveFromSandbox(message)
      .catch((error: unknown) => {
        this.#asyncError ??= normalizeError(error);
      })
      .finally(() => {
        this.#pendingHostOperations.delete(operation);
      });

    this.#pendingHostOperations.add(operation);
  }

  async #drainAsyncOps(): Promise<void> {
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();

    if (this.#pendingHostOperations.size === 0) {
      return;
    }

    await Promise.race(this.#pendingHostOperations);
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  async #flushTransportQueue(): Promise<void> {
    this.#throwIfAsyncError();
    if (!this.#host || this.#transportInbox.length === 0) {
      return;
    }

    if (this.#flushPromise) {
      await this.#flushPromise;
      return;
    }

    const flush = async () => {
      while (this.#transportInbox.length > 0) {
        const message = this.#transportInbox.shift();
        if (message === undefined) {
          continue;
        }

        await this.#host?.callFunction(TRANSPORT_RECEIVE_GLOBAL, message);
        this.#throwIfAsyncError();
      }
    };

    this.#flushPromise = flush().finally(() => {
      this.#flushPromise = undefined;
    });
    await this.#flushPromise;
  }

  async #getPage(name: unknown): Promise<string> {
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
    return extractGuid(page);
  }

  async #newPage(): Promise<string> {
    const page = await this.#options.manager.newPage(this.#options.browserName);
    this.#anonymousPages.add(page);
    page.on("close", () => {
      this.#anonymousPages.delete(page);
    });
    return extractGuid(page);
  }

  async #closePage(name: unknown): Promise<void> {
    await this.#options.manager.closePage(
      this.#options.browserName,
      requireString(name, "Page name")
    );
  }

  async #writeTempFile(name: unknown, payload: unknown): Promise<string> {
    return await writeCanaryTempFile(
      requireString(name, "File name"),
      decodeSandboxFilePayload(payload, "File data")
    );
  }

  async #readTempFile(name: unknown): Promise<string> {
    return await readCanaryTempFile(requireString(name, "File name"));
  }

  async #cleanupAnonymousPages(
    options: { suppressErrors?: boolean } = {}
  ): Promise<void> {
    const anonymousPages = [...this.#anonymousPages];
    this.#anonymousPages.clear();

    for (const page of anonymousPages) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (error) {
        if (!options.suppressErrors) {
          throw error;
        }
      }
    }

    if (options.suppressErrors) {
      try {
        await this.#flushTransportQueue();
      } catch {
        // Best effort cleanup during sandbox teardown.
      }
      return;
    }

    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  #throwIfAsyncError(): void {
    if (this.#asyncError) {
      throw this.#asyncError;
    }
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error("QuickJS sandbox has been disposed");
    }
  }

  #assertInitialized(): void {
    this.#assertAlive();
    if (!(this.#initialized && this.#host && this.#hostBridge)) {
      throw new Error("QuickJS sandbox has not been initialized");
    }
  }
}
