import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "@usecanary/logger";
import { describe, expect, it } from "vitest";
import { SCRUB_PLACEHOLDER, scrubHarFile, scrubHarLog } from "./scrub-har.js";

const log = createLogger({ level: "silent" });

// One entry carrying every shape the scrubber has to reach: sensitive and
// benign request headers, a set-cookie response header, and HAR's structural
// cookie lists (which mirror the header values).
function harFixture() {
  return {
    log: {
      entries: [
        {
          request: {
            cookies: [{ name: "_session_id", value: "live-session-value" }],
            headers: [
              { name: "Cookie", value: "_session_id=live-session-value" },
              { name: "Authorization", value: "Bearer real-token" },
              { name: "Accept", value: "text/html" },
              { name: "x-csrf-token", value: "csrf-abc" },
            ],
            method: "GET",
            url: "https://app.example.com/",
          },
          response: {
            cookies: [{ name: "_session_id", value: "rotated-value" }],
            headers: [
              { name: "set-cookie", value: "_session_id=rotated-value" },
              { name: "content-type", value: "text/html" },
            ],
            status: 200,
          },
        },
      ],
      version: "1.2",
    },
  };
}

function headerValue(
  har: ReturnType<typeof harFixture>,
  side: "request" | "response",
  name: string
): string | undefined {
  const headers = har.log.entries[0]?.[side].headers as
    | { name: string; value: string }[]
    | undefined;
  return headers?.find((h) => h.name.toLowerCase() === name)?.value;
}

describe("scrubHarLog", () => {
  it("replaces credential header values and leaves benign ones intact", () => {
    const har = harFixture();
    const replaced = scrubHarLog(har);

    expect(headerValue(har, "request", "cookie")).toBe(SCRUB_PLACEHOLDER);
    expect(headerValue(har, "request", "authorization")).toBe(
      SCRUB_PLACEHOLDER
    );
    expect(headerValue(har, "response", "set-cookie")).toBe(SCRUB_PLACEHOLDER);
    // Kept: needed to debug, and useless on its own without the cookie.
    expect(headerValue(har, "request", "accept")).toBe("text/html");
    expect(headerValue(har, "request", "x-csrf-token")).toBe("csrf-abc");
    expect(replaced).toBeGreaterThan(0);
  });

  it("scrubs the structural cookie lists too, not just the headers", () => {
    const har = harFixture();
    scrubHarLog(har);

    expect(har.log.entries[0]?.request.cookies[0]?.value).toBe(
      SCRUB_PLACEHOLDER
    );
    expect(har.log.entries[0]?.response.cookies[0]?.value).toBe(
      SCRUB_PLACEHOLDER
    );
    // The name is what makes a scrubbed entry legible — keep it.
    expect(har.log.entries[0]?.request.cookies[0]?.name).toBe("_session_id");
  });

  it("keeps the header name so a reader can see a cookie was sent", () => {
    const har = harFixture();
    scrubHarLog(har);
    const names = (
      har.log.entries[0]?.request.headers as { name: string }[] | undefined
    )?.map((h) => h.name);
    expect(names).toContain("Cookie");
  });

  it("is idempotent — a second pass replaces nothing", () => {
    const har = harFixture();
    expect(scrubHarLog(har)).toBeGreaterThan(0);
    expect(scrubHarLog(har)).toBe(0);
  });

  it("tolerates malformed or partial HARs instead of throwing", () => {
    expect(scrubHarLog(undefined)).toBe(0);
    expect(scrubHarLog({})).toBe(0);
    expect(scrubHarLog({ log: {} })).toBe(0);
    expect(scrubHarLog({ log: { entries: "not-an-array" } })).toBe(0);
    expect(
      scrubHarLog({ log: { entries: [null, {}, { request: null }] } })
    ).toBe(0);
    // A header list with junk in it scrubs the real entries and skips the rest.
    expect(
      scrubHarLog({
        log: {
          entries: [
            {
              request: {
                headers: [
                  null,
                  { name: "Cookie" },
                  { name: "Cookie", value: "x" },
                ],
              },
            },
          ],
        },
      })
    ).toBe(1);
  });
});

describe("scrubHarFile", () => {
  it("rewrites the file in place as valid, scrubbed JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scrub-har-"));
    const harPath = path.join(dir, "network.har");
    await writeFile(harPath, JSON.stringify(harFixture()));

    const outcome = await scrubHarFile(harPath, log);

    expect(outcome.scrubbed).toBe(true);
    const reparsed = JSON.parse(await readFile(harPath, "utf8"));
    expect(reparsed.log.entries[0].request.headers[0].value).toBe(
      SCRUB_PLACEHOLDER
    );
    // The rest of the HAR must survive the round trip untouched.
    expect(reparsed.log.version).toBe("1.2");
    expect(reparsed.log.entries[0].request.url).toBe(
      "https://app.example.com/"
    );
  });

  it("treats a missing HAR as nothing to do, not a failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scrub-har-"));
    const outcome = await scrubHarFile(path.join(dir, "absent.har"), log);
    expect(outcome).toEqual({ replaced: 0, scrubbed: true });
  });

  it("leaves an unparseable HAR untouched and reports why", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scrub-har-"));
    const harPath = path.join(dir, "network.har");
    await writeFile(harPath, "{ not json");

    const outcome = await scrubHarFile(harPath, log);

    expect(outcome.scrubbed).toBe(false);
    // Original bytes intact — a failed scrub must never corrupt the artifact.
    expect(await readFile(harPath, "utf8")).toBe("{ not json");
  });

  it("does not rewrite a HAR that has nothing sensitive in it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scrub-har-"));
    const harPath = path.join(dir, "network.har");
    const clean = JSON.stringify({
      log: {
        entries: [
          { request: { headers: [{ name: "Accept", value: "text/html" }] } },
        ],
      },
    });
    await writeFile(harPath, clean);

    const outcome = await scrubHarFile(harPath, log);

    expect(outcome).toEqual({ replaced: 0, scrubbed: true });
    expect(await readFile(harPath, "utf8")).toBe(clean);
  });
});
