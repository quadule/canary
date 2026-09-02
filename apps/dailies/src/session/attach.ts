// Copying external files into a session's attachments/ directory.
//
// A session's `attachments/` folder is the seam for anything Dailies itself
// doesn't produce: a coverage report, a Lighthouse score, an accessibility
// audit, a database diff. Drop a file there and it appears in `results.json`
// and in the rendered report alongside the trace and video.
//
// This exists so a caller doesn't have to know the on-disk layout, and — more
// importantly — so it can happen as part of `session end`. Both the daemon and
// the on-disk fallback build their artifact list when the session ends, so a
// file copied AFTERWARDS is silently absent from the report. That ordering was
// a documented hazard for every external tool; `session end --attach` makes it
// the command's problem instead of the caller's.

import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "dailies-logger";
import { SESSION_ATTACHMENTS_DIR } from "dailies-protocol";

export interface AttachOutcome {
  // Basenames actually copied, in the order given.
  attached: string[];
  // One line per file that couldn't be copied, and why.
  failures: string[];
}

// Copy each file into `<sessionDir>/attachments/`. Never throws: a missing or
// unreadable file is reported and the rest still land, because losing the whole
// report over a bad path would be a worse outcome than losing one attachment.
// An empty file is skipped — the artifact scanners drop zero-byte files anyway,
// so copying one would silently produce nothing.
export async function attachFiles(args: {
  files: string[];
  log: Logger;
  sessionDir: string;
}): Promise<AttachOutcome> {
  const { files, log, sessionDir } = args;
  const attached: string[] = [];
  const failures: string[] = [];
  if (files.length === 0) {
    return { attached, failures };
  }
  const dir = path.join(sessionDir, SESSION_ATTACHMENTS_DIR);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { attached, failures: [`could not create ${dir} — ${detail}`] };
  }
  for (const file of files) {
    const name = path.basename(file);
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        failures.push(`${file} is not a file`);
        continue;
      }
      if (info.size === 0) {
        failures.push(`${file} is empty — skipped`);
        continue;
      }
      await copyFile(file, path.join(dir, name));
      attached.push(name);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failures.push(`${file} — ${detail}`);
    }
  }
  if (attached.length > 0) {
    log.debug({ attached, dir }, "attached files to the session");
  }
  return { attached, failures };
}
