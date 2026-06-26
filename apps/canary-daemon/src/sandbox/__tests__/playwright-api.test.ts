import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const SANDBOX_TIMEOUT_MS = 60_000;

const TEST_PAGE_HTML = String.raw`<!DOCTYPE html>
<html>
  <head>
    <title>Test Page</title>
    <style>
      body {
        margin: 0;
        font-family: sans-serif;
      }

      #mouse-target {
        position: absolute;
        left: 40px;
        top: 40px;
        width: 120px;
        height: 60px;
        background: #0ea5e9;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #spacer {
        height: 1400px;
      }
    </style>
  </head>
  <body>
    <h1>Hello World</h1>
    <p id="text" data-kind="primary"><strong>Some</strong> text</p>
    <div id="html-block"><span>Inner <strong>HTML</strong></span></div>
    <input id="name" type="text" placeholder="Name" />
    <input id="email" type="email" placeholder="Email" />
    <textarea id="bio"></textarea>
    <input id="agree" type="checkbox" />
    <select id="color">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
      <option value="green">Green</option>
    </select>
    <button id="submit">Submit</button>
    <button id="disabled" disabled>Disabled</button>
    <button id="focus-target">Focus target</button>
    <div id="result"></div>
    <ul id="list">
      <li class="item">Item 1</li>
      <li class="item">Item 2</li>
      <li class="item">Item 3</li>
    </ul>
    <div class="card">
      <span class="label">Alpha</span>
      <span class="child">Child A</span>
    </div>
    <div class="card">
      <span class="label">Beta</span>
      <span class="child">Child B</span>
    </div>
    <div class="parent">
      <span class="child">Nested child</span>
    </div>
    <div id="wait-target" hidden>Loaded later</div>
    <div id="transient">Transient element</div>
    <div id="hidden" style="display:none">Hidden content</div>
    <a href="https://example.com" id="link">Example Link</a>
    <div id="mouse-target">Mouse Target</div>
    <div id="spacer"></div>
    <div id="footer">Footer content</div>
    <script>
      window.events = { inputCount: 0 };
      window.readyFlag = false;
      window.extraReady = false;

      const result = document.getElementById("result");
      const nameInput = document.getElementById("name");
      const emailInput = document.getElementById("email");
      const bioInput = document.getElementById("bio");
      const agreeInput = document.getElementById("agree");
      const colorSelect = document.getElementById("color");

      document.getElementById("submit").addEventListener("click", () => {
        result.textContent = "clicked:" + nameInput.value + ":" + colorSelect.value;
      });

      nameInput.addEventListener("input", () => {
        window.events.inputCount += 1;
      });

      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          result.textContent = "enter:" + nameInput.value;
        }
      });

      emailInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          result.textContent = "email-enter:" + emailInput.value;
        }
      });

      bioInput.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
          document.getElementById("focus-target").focus();
        }
      });

      agreeInput.addEventListener("change", () => {
        result.dataset.checked = String(agreeInput.checked);
      });

      colorSelect.addEventListener("change", () => {
        result.dataset.color = colorSelect.value;
      });

      document.getElementById("mouse-target").addEventListener("click", () => {
        result.dataset.mouse = "clicked";
      });

      setTimeout(() => {
        document.getElementById("wait-target").hidden = false;
        window.readyFlag = true;
      }, 50);

      setTimeout(() => {
        document.getElementById("transient").style.display = "none";
      }, 80);

      setTimeout(() => {
        window.extraReady = "ok";
      }, 120);
    </script>
  </body>
</html>`;

interface CapturedOutput {
  stderr: string[];
  stdout: string[];
}

interface JsonSandboxHarness {
  dispose: () => Promise<void>;
  runJson: <T>(script: string) => Promise<T>;
}

interface NavigationServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function createOutput(): CapturedOutput & {
  sink: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    sink: {
      onStdout: (data) => {
        stdout.push(data);
      },
      onStderr: (data) => {
        stderr.push(data);
      },
    },
  };
}

function clearOutput(output: CapturedOutput): void {
  output.stdout.length = 0;
  output.stderr.length = 0;
}

function outputLines(output: CapturedOutput): string[] {
  return output.stdout
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLastJsonLine<T>(output: CapturedOutput): T {
  const lines = outputLines(output);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines.at(-1)!) as T;
}

function withTestPage(pageName: string, body: string): string {
  return `
    const page = await browser.getPage(${JSON.stringify(pageName)});
    await page.setContent(${JSON.stringify(TEST_PAGE_HTML)}, { waitUntil: "load" });
    ${body}
  `;
}

async function createSandboxHarness(
  manager: BrowserManager,
  browserName: string
): Promise<JsonSandboxHarness> {
  await manager.ensureBrowser(browserName, {
    headless: true,
  });

  const output = createOutput();
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: output.sink.onStdout,
    onStderr: output.sink.onStderr,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  await sandbox.initialize();

  return {
    dispose: async () => {
      await sandbox.dispose();
    },
    runJson: async <T>(script: string): Promise<T> => {
      clearOutput(output);
      await sandbox.executeScript(`(async () => {\n${script}\n})()`);
      expect(output.stderr).toEqual([]);
      return parseLastJsonLine<T>(output);
    },
  };
}

function navigationPageHtml(
  title: string,
  route: string,
  nextPath?: string
): string {
  const nextLink = nextPath
    ? `<a id="next-link" href="${nextPath}">Next</a>`
    : '<span id="next-link">No next link</span>';

  return `<!DOCTYPE html>
<html>
  <head>
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <div id="route">${route}</div>
    ${nextLink}
  </body>
</html>`;
}

function handleNavigationRequest(
  request: IncomingMessage,
  response: ServerResponse
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let html = "";

  switch (url.pathname) {
    case "/nav/first":
      html = navigationPageHtml("First Page", "/nav/first", "/nav/second");
      break;
    case "/nav/second":
      html = navigationPageHtml("Second Page", "/nav/second", "/nav/third");
      break;
    case "/nav/third":
      html = navigationPageHtml("Third Page", "/nav/third");
      break;
    default:
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("not found");
      return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

async function createNavigationServer(): Promise<NavigationServer> {
  const server = createServer(handleNavigationRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Navigation test server did not expose a TCP address");
  }

  const { port } = address as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe.sequential("QuickJS Playwright Page API coverage", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    await ensureSandboxClientBundle();

    browserRootDir = await mkdtemp(
      path.join(os.tmpdir(), "canary-playwright-api-")
    );
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  describe.sequential("navigation", () => {
    const browserName = "playwright-navigation";
    let harness: JsonSandboxHarness;
    let navigationServer: NavigationServer;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
      navigationServer = await createNavigationServer();
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await navigationServer.close();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports goto with waitUntil, url(), and waitForURL()", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        firstUrl: string;
        secondUrl: string;
        firstTitle: string;
        secondTitle: string;
      }>(`
        const page = await browser.getPage("navigation-goto");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        const firstTitle = await page.title();
        const firstUrl = page.url();
        const secondNavigation = page.waitForURL("**/nav/second");
        await page.click("#next-link");
        await secondNavigation;
        console.log(JSON.stringify({
          firstUrl,
          secondUrl: page.url(),
          firstTitle,
          secondTitle: await page.title(),
        }));
      `);

      expect(result.firstUrl).toBe(firstUrl);
      expect(result.secondUrl).toBe(`${navigationServer.baseUrl}/nav/second`);
      expect(result.firstTitle).toBe("First Page");
      expect(result.secondTitle).toBe("Second Page");
    }, 15_000);

    it("supports goBack(), goForward(), and reload()", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const secondUrl = `${navigationServer.baseUrl}/nav/second`;

      const result = await harness.runJson<{
        backUrl: string;
        backTitle: string;
        forwardUrl: string;
        reloadTitle: string;
      }>(`
        const page = await browser.getPage("navigation-history");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        await page.goto(${JSON.stringify(secondUrl)}, { waitUntil: "load" });
        await page.goBack({ waitUntil: "load" });
        const backUrl = page.url();
        const backTitle = await page.title();
        await page.goForward({ waitUntil: "load" });
        const forwardUrl = page.url();
        await page.evaluate(() => {
          document.title = "Mutated Title";
        });
        await page.reload({ waitUntil: "load" });
        console.log(JSON.stringify({
          backUrl,
          backTitle,
          forwardUrl,
          reloadTitle: await page.title(),
        }));
      `);

      expect(result.backUrl).toBe(firstUrl);
      expect(result.backTitle).toBe("First Page");
      expect(result.forwardUrl).toBe(secondUrl);
      expect(result.reloadTitle).toBe("Second Page");
    });

    it("waitForURL resolves on a History API (pushState) navigation", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        startHref: string;
        finalHref: string;
      }>(`
        const page = await browser.getPage("navigation-pushstate");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        const startHref = page.url();
        // Same-document navigation: no full load and no reliable "navigated"
        // event, so the stock waitForURL would hang until timeout.
        const settled = page.waitForURL("**/nav/pushed");
        await page.evaluate(() => history.pushState({}, "", "/nav/pushed"));
        await settled;
        console.log(JSON.stringify({
          startHref,
          finalHref: await page.evaluate(() => location.href),
        }));
      `);

      expect(result.startHref).toBe(firstUrl);
      expect(result.finalHref).toBe(`${navigationServer.baseUrl}/nav/pushed`);
    }, 15_000);

    it("waitForURL rejects when the URL never matches", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        threw: boolean;
        message: string;
      }>(`
        const page = await browser.getPage("navigation-pushstate");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        let threw = false;
        let message = "";
        try {
          await page.waitForURL("**/never-arrives", { timeout: 600 });
        } catch (error) {
          threw = true;
          message = String(error && error.message ? error.message : error);
        }
        console.log(JSON.stringify({ threw, message }));
      `);

      expect(result.threw).toBe(true);
      expect(result.message).toContain("timed out");
    }, 15_000);

    it("waitForURLChange resolves on a pushState nav without a known target", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        startHref: string;
        changedHref: string;
      }>(`
        const page = await browser.getPage("navigation-url-change");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        const startHref = await page.evaluate(() => location.href);
        // Don't pass a destination — just "wait until it changes". Capture
        // before the nav and run both so "from" can't be the post-nav URL.
        const [changedHref] = await Promise.all([
          page.waitForURLChange({ from: startHref }),
          page.evaluate(() => history.pushState({}, "", "/nav/pushed")),
        ]);
        console.log(JSON.stringify({ startHref, changedHref }));
      `);

      expect(result.startHref).toBe(firstUrl);
      expect(result.changedHref).toBe(`${navigationServer.baseUrl}/nav/pushed`);
    }, 15_000);

    it("waitForURLChange throws when the URL never changes", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        threw: boolean;
        message: string;
      }>(`
        const page = await browser.getPage("navigation-url-change-timeout");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        let threw = false;
        let message = "";
        try {
          await page.waitForURLChange({ timeout: 600 });
        } catch (error) {
          threw = true;
          message = String(error && error.message ? error.message : error);
        }
        console.log(JSON.stringify({ threw, message }));
      `);

      expect(result.threw).toBe(true);
      expect(result.message).toContain("did not change");
    }, 15_000);

    it("humanClickAndWaitForURL clicks a link and resolves on the loaded new page", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        startHref: string;
        newHref: string;
        title: string;
      }>(`
        const page = await browser.getPage("navigation-human-click-wait");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        const startHref = await page.evaluate(() => location.href);
        // One call: captures the URL before the click, clicks, waits for the
        // URL to change AND the new document to load — then returns the href.
        const newHref = await page.humanClickAndWaitForURL("#next-link");
        console.log(JSON.stringify({
          startHref,
          newHref,
          title: await page.title(),
        }));
      `);

      expect(result.startHref).toBe(firstUrl);
      expect(result.newHref).toBe(`${navigationServer.baseUrl}/nav/second`);
      // page.title() reflects the NEW document, proving the load-state wait ran.
      expect(result.title).toBe("Second Page");
    }, 20_000);

    it("humanClickAndWaitForURL accepts an explicit destination url", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{ newHref: string }>(`
        const page = await browser.getPage("navigation-human-click-url");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        const newHref = await page.humanClickAndWaitForURL("#next-link", {
          url: "**/nav/second",
        });
        console.log(JSON.stringify({ newHref }));
      `);

      expect(result.newHref).toBe(`${navigationServer.baseUrl}/nav/second`);
    }, 20_000);

    it("humanClickAndWaitForURL handles a same-document (Turbo-style) click nav", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        startHref: string;
        newHref: string;
      }>(`
        const page = await browser.getPage("navigation-human-click-pushstate");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        // Simulate Turbo/Hotwire: intercept the link click and pushState after a
        // gap instead of a full document load (no new "load" fires). This is the
        // case the old humanClick + waitForSettled + page.url() pattern lost —
        // the DOM falls quiet during the gap, so waitForSettled returns before
        // the pushState. humanClickAndWaitForURL polls location.href across it.
        await page.evaluate(() => {
          const link = document.getElementById("next-link");
          link.addEventListener("click", (event) => {
            event.preventDefault();
            setTimeout(() => history.pushState({}, "", "/nav/pushed-by-click"), 150);
          });
        });
        const startHref = await page.evaluate(() => location.href);
        const newHref = await page.humanClickAndWaitForURL("#next-link");
        console.log(JSON.stringify({ startHref, newHref }));
      `);

      expect(result.startHref).toBe(firstUrl);
      expect(result.newHref).toBe(
        `${navigationServer.baseUrl}/nav/pushed-by-click`
      );
    }, 20_000);

    it("humanClickAndWaitForURL throws when the click does not navigate", async () => {
      const thirdUrl = `${navigationServer.baseUrl}/nav/third`;
      const result = await harness.runJson<{
        threw: boolean;
        message: string;
      }>(`
        const page = await browser.getPage("navigation-human-click-no-nav");
        await page.goto(${JSON.stringify(thirdUrl)}, { waitUntil: "domcontentloaded" });
        let threw = false;
        let message = "";
        try {
          // On /nav/third, #next-link is a non-navigating <span>.
          await page.humanClickAndWaitForURL("#next-link", { timeout: 600 });
        } catch (error) {
          threw = true;
          message = String(error && error.message ? error.message : error);
        }
        console.log(JSON.stringify({ threw, message }));
      `);

      expect(result.threw).toBe(true);
      expect(result.message).toContain("did not change");
    }, 15_000);
  });

  describe.sequential("content and evaluation", () => {
    const browserName = "playwright-content-evaluation";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("reads page content through page methods", async () => {
      const result = await harness.runJson<{
        title: string;
        contentHasTitle: boolean;
        contentHasFooter: boolean;
        text: string | null;
        html: string;
        innerText: string;
        kind: string | null;
        href: string | null;
      }>(
        withTestPage(
          "content-reading",
          `
          const content = await page.content();
          console.log(JSON.stringify({
            title: await page.title(),
            contentHasTitle: content.includes("<title>Test Page</title>"),
            contentHasFooter: content.includes("Footer content"),
            text: await page.textContent("#text"),
            html: await page.innerHTML("#html-block"),
            innerText: await page.innerText("#text"),
            kind: await page.getAttribute("#text", "data-kind"),
            href: await page.getAttribute("#link", "href"),
          }));
        `
        )
      );

      expect(result.title).toBe("Test Page");
      expect(result.contentHasTitle).toBe(true);
      expect(result.contentHasFooter).toBe(true);
      expect(result.text).toBe("Some text");
      expect(result.html).toContain("<strong>HTML</strong>");
      expect(result.innerText).toBe("Some text");
      expect(result.kind).toBe("primary");
      expect(result.href).toBe("https://example.com");
    });

    it("supports evaluate(), evaluate(arg), $eval(), and $$eval()", async () => {
      const result = await harness.runJson<{
        pageTitle: string;
        sum: number;
        upperText: string;
        listItems: string[];
      }>(
        withTestPage(
          "evaluation-methods",
          `
          const pageTitle = await page.evaluate(() => document.title);
          const sum = await page.evaluate((values) => values.left + values.right, {
            left: 2,
            right: 3,
          });
          const upperText = await page.$eval("#text", (element) => {
            return (element.textContent ?? "").toUpperCase();
          });
          const listItems = await page.$$eval("#list li", (elements) => {
            return elements.map((element) => element.textContent ?? "");
          });
          console.log(JSON.stringify({
            pageTitle,
            sum,
            upperText,
            listItems,
          }));
        `
        )
      );

      expect(result.pageTitle).toBe("Test Page");
      expect(result.sum).toBe(5);
      expect(result.upperText).toBe("SOME TEXT");
      expect(result.listItems).toEqual(["Item 1", "Item 2", "Item 3"]);
    });
  });

  describe.sequential("form interaction and waiting", () => {
    const browserName = "playwright-form-waiting";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports fill(), click(), type(), press(), check(), uncheck(), and selectOption()", async () => {
      const result = await harness.runJson<{
        bio: string;
        name: string;
        email: string;
        inputCount: number;
        enterResult: string | null;
        clickResult: string | null;
        checkedAfterCheck: boolean;
        checkedAfterUncheck: boolean;
        selectedValues: string[];
        selectedValue: string;
      }>(
        withTestPage(
          "form-interaction",
          `
          await page.fill("#bio", "QuickJS bio");
          await page.type("#name", "Ada");
          const name = await page.inputValue("#name");
          const inputCount = await page.evaluate(() => window.events.inputCount);
          await page.press("#name", "Enter");
          const enterResult = await page.textContent("#result");
          await page.type("#email", "ada@example.com");
          await page.check("#agree");
          const checkedAfterCheck = await page.isChecked("#agree");
          const selectedValues = await page.selectOption("#color", "blue");
          const selectedValue = await page.inputValue("#color");
          await page.click("#submit");
          const clickResult = await page.textContent("#result");
          await page.uncheck("#agree");
          const checkedAfterUncheck = await page.isChecked("#agree");
          console.log(JSON.stringify({
            bio: await page.inputValue("#bio"),
            name,
            email: await page.inputValue("#email"),
            inputCount,
            enterResult,
            clickResult,
            checkedAfterCheck,
            checkedAfterUncheck,
            selectedValues,
            selectedValue,
          }));
        `
        )
      );

      expect(result.bio).toBe("QuickJS bio");
      expect(result.name).toBe("Ada");
      expect(result.email).toBe("ada@example.com");
      expect(result.inputCount).toBe(3);
      expect(result.enterResult).toBe("enter:Ada");
      expect(result.clickResult).toBe("clicked:Ada:blue");
      expect(result.checkedAfterCheck).toBe(true);
      expect(result.checkedAfterUncheck).toBe(false);
      expect(result.selectedValues).toEqual(["blue"]);
      expect(result.selectedValue).toBe("blue");
    });

    it("supports waitForSelector(), waitForTimeout(), and waitForFunction()", async () => {
      const result = await harness.runJson<{
        timeoutElapsed: number;
        waitTargetText: string | null;
        transientHidden: boolean;
        readyValue: string;
      }>(
        withTestPage(
          "wait-methods",
          `
          const start = Date.now();
          await page.waitForTimeout(40);
          const timeoutElapsed = Date.now() - start;
          await page.waitForSelector("#wait-target");
          await page.waitForSelector("#transient", { state: "hidden" });
          const readyHandle = await page.waitForFunction(() => window.extraReady);
          const readyValue = await readyHandle.jsonValue();
          await readyHandle.dispose();
          console.log(JSON.stringify({
            timeoutElapsed,
            waitTargetText: await page.textContent("#wait-target"),
            transientHidden: await page.isHidden("#transient"),
            readyValue,
          }));
        `
        )
      );

      expect(result.timeoutElapsed).toBeGreaterThanOrEqual(20);
      expect(result.waitTargetText).toBe("Loaded later");
      expect(result.transientHidden).toBe(true);
      expect(result.readyValue).toBe("ok");
    });
  });

  describe.sequential("locators and multiple elements", () => {
    const browserName = "playwright-locators";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports locator actions, text helpers, visibility, enabled state, and nth accessors", async () => {
      const result = await harness.runJson<{
        textContent: string | null;
        innerText: string;
        kind: string | null;
        visible: boolean;
        hiddenVisible: boolean;
        submitEnabled: boolean;
        disabledEnabled: boolean;
        count: number;
        first: string | null;
        last: string | null;
        second: string | null;
        clickResult: string | null;
      }>(
        withTestPage(
          "locator-basics",
          `
          await page.locator("#name").fill("Grace");
          await page.locator("#submit").click();
          console.log(JSON.stringify({
            textContent: await page.locator("#text").textContent(),
            innerText: await page.locator("#text").innerText(),
            kind: await page.locator("#text").getAttribute("data-kind"),
            visible: await page.locator("#text").isVisible(),
            hiddenVisible: await page.locator("#hidden").isVisible(),
            submitEnabled: await page.locator("#submit").isEnabled(),
            disabledEnabled: await page.locator("#disabled").isEnabled(),
            count: await page.locator("#list li").count(),
            first: await page.locator("#list li").first().textContent(),
            last: await page.locator("#list li").last().textContent(),
            second: await page.locator("#list li").nth(1).textContent(),
            clickResult: await page.locator("#result").textContent(),
          }));
        `
        )
      );

      expect(result.textContent).toBe("Some text");
      expect(result.innerText).toBe("Some text");
      expect(result.kind).toBe("primary");
      expect(result.visible).toBe(true);
      expect(result.hiddenVisible).toBe(false);
      expect(result.submitEnabled).toBe(true);
      expect(result.disabledEnabled).toBe(false);
      expect(result.count).toBe(3);
      expect(result.first).toBe("Item 1");
      expect(result.last).toBe("Item 3");
      expect(result.second).toBe("Item 2");
      expect(result.clickResult).toBe("clicked:Grace:red");
    });

    it("supports filter(), chained locators, locator.all(), and iterating multiple elements", async () => {
      const result = await harness.runJson<{
        betaLabel: string | null;
        betaChild: string | null;
        nestedChild: string | null;
        items: string[];
      }>(
        withTestPage(
          "locator-advanced",
          `
          const betaCard = page.locator(".card").filter({ hasText: "Beta" });
          const items = [];
          for (const item of await page.locator("#list li").all()) {
            items.push(await item.innerText());
          }
          console.log(JSON.stringify({
            betaLabel: await betaCard.locator(".label").textContent(),
            betaChild: await betaCard.locator(".child").textContent(),
            nestedChild: await page.locator(".parent").locator(".child").textContent(),
            items,
          }));
        `
        )
      );

      expect(result.betaLabel).toBe("Beta");
      expect(result.betaChild).toBe("Child B");
      expect(result.nestedChild).toBe("Nested child");
      expect(result.items).toEqual(["Item 1", "Item 2", "Item 3"]);
    });
  });

  describe.sequential("AI snapshots", () => {
    const browserName = "playwright-snapshots";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports page.snapshotForAI()", async () => {
      const result = await harness.runJson<{
        full: string;
        incremental?: string;
      }>(
        withTestPage(
          "snapshot-main",
          `
          const result = await page.snapshotForAI();
          console.log(JSON.stringify(result));
        `
        )
      );

      expect(result.incremental).toBeUndefined();
      expect(result.full).toContain('heading "Hello World"');
      expect(result.full).toContain('button "Submit"');
    });

    it("scopes the snapshot to a selector", async () => {
      const result = await harness.runJson<{ full: string; scoped: string }>(`
        const page = await browser.getPage("snapshot-selector");
        await page.setContent(
          "<nav><a href='#'>NAVLINK_UNIQUE</a></nav><main><h1>MAINHEADING_UNIQUE</h1><p>Body copy</p></main>",
          { waitUntil: "load" }
        );
        const full = (await page.snapshotForAI()).full;
        const scoped = (await page.snapshotForAI({ selector: "main" })).full;
        console.log(JSON.stringify({ full, scoped }));
      `);

      expect(result.full).toContain("NAVLINK_UNIQUE");
      expect(result.full).toContain("MAINHEADING_UNIQUE");
      // Scoping to <main> drops the surrounding nav chrome.
      expect(result.scoped).toContain("MAINHEADING_UNIQUE");
      expect(result.scoped).not.toContain("NAVLINK_UNIQUE");
    });

    it("returns an incremental diff when tracking across snapshots", async () => {
      const baselineHtml = `<main><h1>TrackHeading</h1><ul>${Array.from(
        { length: 40 },
        (_, i) => `<li>List entry number ${i}</li>`
      ).join("")}</ul></main>`;

      const result = await harness.runJson<{
        baselineFull: string;
        baselineIncremental?: string;
        baselineLen: number;
        unchangedLen: number;
        changedFull: string;
        changedIncremental?: string;
      }>(`
        const page = await browser.getPage("snapshot-track");
        await page.setContent(${JSON.stringify(baselineHtml)}, { waitUntil: "load" });
        const baseline = await page.snapshotForAI({ track: "t1" });
        const unchanged = await page.snapshotForAI({ track: "t1" });
        await page.evaluate(() => {
          const button = document.createElement("button");
          button.textContent = "DIFFBUTTON_UNIQUE";
          document.querySelector("main").appendChild(button);
        });
        const changed = await page.snapshotForAI({ track: "t1" });
        console.log(JSON.stringify({
          baselineFull: baseline.full,
          baselineIncremental: baseline.incremental,
          baselineLen: baseline.full.length,
          unchangedLen: unchanged.full.length,
          changedFull: changed.full,
          changedIncremental: changed.incremental,
        }));
      `);

      // First tracked call has no baseline → full tree, mirrored to incremental.
      expect(result.baselineIncremental).toBe(result.baselineFull);
      expect(result.baselineFull).toContain('heading "TrackHeading"');
      // A second snapshot with no DOM change diffs to (near) nothing.
      expect(result.unchangedLen).toBeLessThan(result.baselineLen);
      // After a mutation, the diff surfaces the new node under both keys.
      expect(result.changedFull).toContain("DIFFBUTTON_UNIQUE");
      expect(result.changedIncremental).toBe(result.changedFull);
    });

    it("tracks snapshot diffs across separate sandbox executions (steps)", async () => {
      // Each session step runs in a FRESH sandbox/connection, but the page —
      // and the server-side track baseline — persists in the daemon. Two
      // sandboxes on the same browser + page name model two steps.
      const stepBrowser = "playwright-track-cross-step";
      const bigHtml = `<main><h1>CrossStepHeading</h1><ul>${Array.from(
        { length: 40 },
        (_, i) => `<li>List entry number ${i}</li>`
      ).join("")}</ul></main>`;

      const stepOne = await createSandboxHarness(manager, stepBrowser);
      let baselineLen = 0;
      try {
        const first = await stepOne.runJson<{ full: string; len: number }>(`
          const page = await browser.getPage("cross-step");
          await page.setContent(${JSON.stringify(bigHtml)}, { waitUntil: "load" });
          const snap = await page.snapshotForAI({ track: "step" });
          console.log(JSON.stringify({ full: snap.full, len: snap.full.length }));
        `);
        baselineLen = first.len;
        expect(first.full).toContain("List entry number 0");
      } finally {
        await stepOne.dispose();
      }

      const stepTwo = await createSandboxHarness(manager, stepBrowser);
      try {
        const second = await stepTwo.runJson<{
          full: string;
          incremental?: string;
          len: number;
        }>(`
          const page = await browser.getPage("cross-step");
          await page.evaluate(() => {
            const button = document.createElement("button");
            button.textContent = "CROSSSTEP_UNIQUE";
            document.querySelector("main").appendChild(button);
          });
          const snap = await page.snapshotForAI({ track: "step" });
          console.log(JSON.stringify({
            full: snap.full,
            incremental: snap.incremental,
            len: snap.full.length,
          }));
        `);

        // The new sandbox diffs against the baseline set in the previous one.
        expect(second.full).toContain("CROSSSTEP_UNIQUE");
        expect(second.incremental).toBe(second.full);
        expect(second.len).toBeLessThan(baselineLen);
      } finally {
        await stepTwo.dispose();
        await manager.stopBrowser(stepBrowser);
      }
    }, 30_000);
  });

  describe.sequential("screenshots and input devices", () => {
    const browserName = "playwright-media-input";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports screenshot() and screenshot({ fullPage: true })", async () => {
      const result = await harness.runJson<{
        screenshotLength: number;
        fullPageLength: number;
      }>(
        withTestPage(
          "screenshots",
          `
          const screenshot = await page.screenshot();
          const fullPage = await page.screenshot({ fullPage: true });
          console.log(JSON.stringify({
            screenshotLength: screenshot.length,
            fullPageLength: fullPage.length,
          }));
        `
        )
      );

      expect(result.screenshotLength).toBeGreaterThan(0);
      expect(result.fullPageLength).toBeGreaterThan(0);
    });

    it("supports page.keyboard and page.mouse", async () => {
      const result = await harness.runJson<{
        typedValue: string;
        enterResult: string | null;
        mouseResult: string | null;
      }>(
        withTestPage(
          "input-devices",
          `
          await page.click("#name");
          await page.keyboard.type("hello");
          await page.keyboard.press("Enter");
          const enterResult = await page.textContent("#result");
          await page.mouse.click(80, 80);
          console.log(JSON.stringify({
            typedValue: await page.inputValue("#name"),
            enterResult,
            mouseResult: await page.getAttribute("#result", "data-mouse"),
          }));
        `
        )
      );

      expect(result.typedValue).toBe("hello");
      expect(result.enterResult).toBe("enter:hello");
      expect(result.mouseResult).toBe("clicked");
    });
  });

  describe.sequential("events", () => {
    const browserName = "playwright-events";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports page.on('console')", async () => {
      const result = await harness.runJson<{
        messages: Array<{ type: string; text: string }>;
      }>(
        withTestPage(
          "console-events",
          `
          const messages = [];
          page.on("console", (message) => {
            messages.push({
              type: message.type(),
              text: message.text(),
            });
          });
          await page.evaluate(() => {
            console.log("from-page", 123);
          });
          await page.waitForTimeout(50);
          console.log(JSON.stringify({ messages }));
        `
        )
      );

      expect(result.messages).toEqual([
        {
          type: "log",
          text: "from-page 123",
        },
      ]);
    });
  });

  describe.sequential("human interaction helpers", () => {
    const browserName = "playwright-human-helpers";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("showCaption clamps an over-long caption to two lines", async () => {
      const result = await harness.runJson<{
        lineHeight: number;
        renderedHeight: number;
        clamped: boolean;
      }>(
        withTestPage(
          "caption-clamp",
          `
          const longText = "This is a deliberately long caption that runs well past two lines so we can prove the overflow is clamped rather than growing into a wall of text across the whole page.";
          await page.showCaption(longText, { durationMs: 5000 });
          const metrics = await page.evaluate(() => {
            const el = document.querySelector("canary-caption");
            const lh = parseFloat(getComputedStyle(el).lineHeight);
            return {
              lineHeight: lh,
              renderedHeight: el.getBoundingClientRect().height,
              // scrollHeight exceeds clientHeight only when content is clipped.
              clamped: el.scrollHeight > el.clientHeight + 1,
            };
          });
          console.log(JSON.stringify(metrics));
        `
        )
      );

      // Rendered box holds at most two text lines plus the 12px*2 vertical
      // padding — far short of the ~10 lines the untruncated text would need.
      expect(result.clamped).toBe(true);
      expect(result.renderedHeight).toBeLessThanOrEqual(
        result.lineHeight * 2 + 24 + 2
      );
    }, 15_000);

    it("humanClick glides the pointer onto the target before pressing", async () => {
      // Record every pointer event the page sees so we can prove a mousemove
      // arrived at the element's centre BEFORE the mousedown — i.e. the cursor
      // travelled to the target rather than the press landing on a teleport.
      const result = await harness.runJson<{
        events: Array<{ type: string; x: number; y: number }>;
        centerX: number;
        centerY: number;
        mouseResult: string | null;
        elapsedMs: number;
      }>(
        withTestPage(
          "human-click",
          `
          await page.evaluate(() => {
            window.__pointer = [];
            const record = (type) => (event) =>
              window.__pointer.push({
                type,
                x: Math.round(event.clientX),
                y: Math.round(event.clientY),
              });
            window.addEventListener("mousemove", record("move"), true);
            window.addEventListener("mousedown", record("down"), true);
          });
          const box = await page.locator("#mouse-target").boundingBox();
          const start = Date.now();
          await page.humanClick("#mouse-target");
          const elapsedMs = Date.now() - start;
          console.log(JSON.stringify({
            events: await page.evaluate(() => window.__pointer),
            centerX: Math.round(box.x + box.width / 2),
            centerY: Math.round(box.y + box.height / 2),
            mouseResult: await page.getAttribute("#result", "data-mouse"),
            elapsedMs,
          }));
        `
        )
      );

      // The click landed.
      expect(result.mouseResult).toBe("clicked");

      const firstDown = result.events.findIndex((e) => e.type === "down");
      expect(firstDown).toBeGreaterThan(0); // a move preceded the press

      // The move immediately before the press sat on the element's centre.
      const moveBeforeDown = result.events[firstDown - 1]!;
      expect(moveBeforeDown.type).toBe("move");
      expect(Math.abs(moveBeforeDown.x - result.centerX)).toBeLessThanOrEqual(
        3
      );
      expect(Math.abs(moveBeforeDown.y - result.centerY)).toBeLessThanOrEqual(
        3
      );

      // The settle pause (cursor glide) actually elapsed before the press.
      expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
    }, 15_000);

    it("humanFill clears the field and types with real per-character key events", async () => {
      const result = await harness.runJson<{
        value: string;
        inputCount: number;
        accepts: string;
      }>(
        withTestPage(
          "human-fill",
          `
          // Seed an existing value to prove humanFill clears before typing.
          await page.fill("#name", "stale");
          await page.evaluate(() => { window.events.inputCount = 0; });
          // Accepts a string selector...
          await page.humanFill("#name", "Ada");
          const value = await page.inputValue("#name");
          const inputCount = await page.evaluate(() => window.events.inputCount);
          // ...and a Locator.
          await page.humanFill(page.getByPlaceholder("Email"), "ada@example.com");
          console.log(JSON.stringify({
            value,
            inputCount,
            accepts: await page.inputValue("#email"),
          }));
        `
        )
      );

      expect(result.value).toBe("Ada");
      expect(result.accepts).toBe("ada@example.com");
      // One input event per typed character (3) — atomic fill would be 1.
      expect(result.inputCount).toBeGreaterThanOrEqual(3);
    }, 15_000);

    it("reveal scrolls a target into view without clicking it", async () => {
      const result = await harness.runJson<{
        beforeInView: boolean;
        afterInView: boolean;
        mouseResult: string | null;
      }>(
        withTestPage(
          "reveal",
          `
          const inView = () =>
            page.evaluate(() => {
              const r = document
                .getElementById("footer")
                .getBoundingClientRect();
              return r.top >= 0 && r.bottom <= window.innerHeight;
            });
          const beforeInView = await inView();
          await page.reveal("#footer");
          const afterInView = await inView();
          console.log(JSON.stringify({
            beforeInView,
            afterInView,
            mouseResult: await page.getAttribute("#result", "data-mouse"),
          }));
        `
        )
      );

      // #footer sits below a 1400px spacer — off-screen until revealed.
      expect(result.beforeInView).toBe(false);
      expect(result.afterInView).toBe(true);
      // reveal shows the element; it must not click anything.
      expect(result.mouseResult).toBeNull();
    }, 15_000);
  });

  describe.sequential("dialogs", () => {
    const browserName = "playwright-dialogs";

    beforeAll(async () => {
      await manager.ensureBrowser(browserName, { headless: true });
    }, 180_000);

    // A low-level runner: unlike the JSON harness it tolerates stderr and
    // surfaces whether the script threw, so we can assert the failure path.
    async function runScript(
      script: string
    ): Promise<{ stdout: string; stderr: string; error?: string }> {
      const output = createOutput();
      const sandbox = new QuickJSSandbox({
        manager,
        browserName,
        onStdout: output.sink.onStdout,
        onStderr: output.sink.onStderr,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      });
      await sandbox.initialize();
      let error: string | undefined;
      try {
        await sandbox.executeScript(`(async () => {\n${script}\n})()`);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        await sandbox.dispose();
      }
      return {
        stdout: output.stdout.join(""),
        stderr: output.stderr.join(""),
        error,
      };
    }

    const confirmPage = (pageName: string) => `
      const page = await browser.getPage(${JSON.stringify(pageName)});
      await page.setContent(
        '<button id="go" onclick="window.__r = confirm(\\'Delete this?\\')">go</button>',
        { waitUntil: "load" }
      );
    `;

    afterAll(async () => {
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("fails the step on an unhandled dialog, naming the dialog and the fix", async () => {
      const result = await runScript(`
        ${confirmPage("dialog-unhandled")}
        await page.humanClick(page.locator("#go"));
        await page.waitForTimeout(50);
        console.log("STILL-RUNNING");
      `);

      // The step fails rather than silently passing, and the message is
      // self-contained: dialog type, its text, and how to handle it.
      const surfaced = `${result.error ?? ""}${result.stderr}`;
      expect(surfaced).toContain("Unhandled confirm dialog");
      expect(surfaced).toContain("Delete this?");
      expect(surfaced).toContain("page.acceptDialogs()");
      expect(result.error).toBeDefined();
    }, 30_000);

    it("leaves the page usable for the next step (dialog was dismissed)", async () => {
      // First step trips the unhandled-dialog failure...
      await runScript(`
        ${confirmPage("dialog-recover")}
        await page.humanClick(page.locator("#go"));
      `);

      // ...and the persistent page must NOT be frozen by a still-open dialog:
      // a fresh step on the same page name should run normally.
      const next = await runScript(`
        const page = await browser.getPage("dialog-recover");
        await page.setContent("<div id='ok'>ready</div>", { waitUntil: "load" });
        console.log(await page.locator("#ok").textContent());
      `);
      expect(next.error).toBeUndefined();
      expect(next.stdout).toContain("ready");
    }, 30_000);

    it("proceeds when the script opts into accepting dialogs", async () => {
      const result = await runScript(`
        ${confirmPage("dialog-accept")}
        await page.acceptDialogs();
        await page.humanClick(page.locator("#go"));
        console.log(JSON.stringify({ r: await page.evaluate(() => window.__r) }));
      `);

      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({
        r: true,
      });
    }, 30_000);

    it("fails with pointed guidance when a script uses the unsupported page.on('dialog')", async () => {
      const result = await runScript(`
        ${confirmPage("dialog-scripted")}
        page.on("dialog", (d) => d.accept());
        await page.humanClick(page.locator("#go"));
        await page.waitForTimeout(50);
      `);

      // Canary owns dialog delivery, so the listener never fires. Rather than
      // hang, the step fails and points at the supported override.
      const surfaced = `${result.error ?? ""}${result.stderr}`;
      expect(surfaced).toContain('page.on("dialog"');
      expect(surfaced).toContain("page.acceptDialogs()");
      expect(result.error).toBeDefined();
    }, 30_000);

    it("resets the dialog policy each step (accept does not leak forward)", async () => {
      // Step 1 accepts on this page...
      const first = await runScript(`
        ${confirmPage("dialog-reset")}
        await page.acceptDialogs();
        await page.humanClick(page.locator("#go"));
        console.log(JSON.stringify({ r: await page.evaluate(() => window.__r) }));
      `);
      expect(first.error).toBeUndefined();
      expect(JSON.parse(first.stdout.trim().split("\n").at(-1)!)).toEqual({
        r: true,
      });

      // ...step 2 on the SAME page must start strict again: an unhandled dialog
      // fails, so accept can't quietly harden into boilerplate.
      const second = await runScript(`
        const page = await browser.getPage("dialog-reset");
        await page.setContent(
          '<button id="go2" onclick="confirm(\\'Again?\\')">go</button>',
          { waitUntil: "load" }
        );
        await page.humanClick(page.locator("#go2"));
        await page.waitForTimeout(50);
      `);
      expect(`${second.error ?? ""}${second.stderr}`).toContain(
        "Unhandled confirm dialog"
      );
      expect(second.error).toBeDefined();
    }, 45_000);
  });
});
