// Strip credentials out of a recorded session's HAR.
//
// Playwright records every request header verbatim, so a session driven against
// a logged-in app leaves live `Cookie` / `set-cookie` / `Authorization` values
// in `network.har` — and a session directory is meant to be handed to someone
// else. Header NAMES are kept (so "this request carried a cookie" is still
// visible when debugging); only the values are replaced.
//
// This does NOT make a session directory safe to publish wholesale: the
// Playwright trace holds the same traffic, response bodies can carry tokens of
// their own, and the browser `profile/` directory contains a real Chrome cookie
// database. See the artifact table in the README.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Logger } from "dailies-logger";

export const SCRUB_PLACEHOLDER = "[scrubbed]";

// Headers whose value is, on its own, enough to act as the user. Kept
// deliberately tight: scrubbing more (a CSRF token, a request id) costs real
// debugging signal without removing a session-takeover risk.
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

interface NameValue {
  name?: unknown;
  value?: unknown;
}

function scrubNameValueList(list: unknown): number {
  if (!Array.isArray(list)) {
    return 0;
  }
  let count = 0;
  for (const item of list) {
    const entry = item as NameValue;
    if (
      typeof entry?.name === "string" &&
      typeof entry.value === "string" &&
      entry.value !== SCRUB_PLACEHOLDER &&
      SENSITIVE_HEADERS.has(entry.name.toLowerCase())
    ) {
      entry.value = SCRUB_PLACEHOLDER;
      count++;
    }
  }
  return count;
}

// HAR models cookies structurally too (`request.cookies` / `response.cookies`),
// so a value scrubbed from the header would otherwise survive here.
function scrubCookieList(list: unknown): number {
  if (!Array.isArray(list)) {
    return 0;
  }
  let count = 0;
  for (const item of list) {
    const cookie = item as { value?: unknown };
    if (
      typeof cookie?.value === "string" &&
      cookie.value !== SCRUB_PLACEHOLDER
    ) {
      cookie.value = SCRUB_PLACEHOLDER;
      count++;
    }
  }
  return count;
}

// Scrub a parsed HAR in place. Returns the number of values replaced, so the
// caller can report what it did (and say nothing when there was nothing to do).
// Tolerant of shape: a malformed or partial HAR scrubs what it can rather than
// throwing. Pure apart from the in-place mutation → unit-tested.
export function scrubHarLog(har: unknown): number {
  const entries = (har as { log?: { entries?: unknown } })?.log?.entries;
  if (!Array.isArray(entries)) {
    return 0;
  }
  let count = 0;
  for (const item of entries) {
    const entry = item as { request?: unknown; response?: unknown };
    for (const side of [entry?.request, entry?.response]) {
      const message = side as { headers?: unknown; cookies?: unknown };
      if (!message) {
        continue;
      }
      count += scrubNameValueList(message.headers);
      count += scrubCookieList(message.cookies);
    }
  }
  return count;
}

export type ScrubHarOutcome =
  | { scrubbed: true; replaced: number }
  | { scrubbed: false; reason: string };

// Rewrite `harPath` with its credentials scrubbed, atomically (temp + rename)
// so an interrupted or failed pass can never leave a truncated HAR behind. On
// any failure the original file is left exactly as it was and the reason is
// returned — the caller decides how loudly to say so. A missing HAR (capture
// disabled with --no-har) is not an error.
export async function scrubHarFile(
  harPath: string,
  logger: Logger
): Promise<ScrubHarOutcome> {
  const tmp = `${harPath}.scrub-${process.pid}`;
  try {
    const raw = await readFile(harPath, "utf8");
    const har = JSON.parse(raw) as unknown;
    const replaced = scrubHarLog(har);
    if (replaced === 0) {
      return { replaced: 0, scrubbed: true };
    }
    await writeFile(tmp, JSON.stringify(har));
    await rename(tmp, harPath);
    logger.debug({ harPath, replaced }, "scrubbed credentials from the HAR");
    return { replaced, scrubbed: true };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    // No HAR on disk means capture was off (--no-har). Nothing to scrub, and
    // nothing worth warning about.
    if ((err as { code?: string })?.code === "ENOENT") {
      return { replaced: 0, scrubbed: true };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { reason, scrubbed: false };
  }
}
