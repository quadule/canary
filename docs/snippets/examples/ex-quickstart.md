const page = await browser.getPage("main");          // named, persistent page
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());

const headings = await page.evaluate(() =>
  [...document.querySelectorAll("h1, h2")].map((h) => h.textContent.trim())
);
console.log(JSON.stringify(headings));

// The link navigates — wait for the new page before reading, so the screenshot
// (and any later read) lands on the destination, not the old/half-loaded page.
const href = await page.humanClickAndWaitForURL(
  page.getByRole("link", { name: "More information" })
);
console.log(href);
const buf = await page.screenshot({ fullPage: false });
await saveScreenshot(buf, "page.png");               // saveScreenshot(buffer, name)
