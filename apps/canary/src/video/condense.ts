// Post-process session videos so reviewers don't scrub through dead air:
// drop the leading still segment (white frames before the first page paints)
// and cap every other motionless stretch at MAX_STILL_SEC seconds.
//
// Two ffmpeg passes over each *.webm:
//   1. freezedetect (analysis only) → freeze_start/freeze_end timestamps on
//      stderr, total decoded duration via -progress on stdout.
//   2. select/setpts re-encode keeping only the computed segments — decodes
//      every frame and filters by timestamp, so cuts are frame-accurate. A
//      Playwright VP8 screencast emits a single keyframe at t=0, so a
//      keyframe-bound stream copy would silently drop any kept segment that
//      doesn't start at one (e.g. a cursor glide / click after a >1s dwell).
//
// ffmpeg is an OPTIONAL dependency: resolved from $CANARY_FFMPEG, then PATH,
// then Playwright's browser cache (Playwright installs its own ffmpeg build
// alongside Chromium for screencasts). When unavailable — or when either pass
// fails — the original video is kept untouched and the report still renders.
import { execFile } from "node:child_process";
import { access, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@usecanary/logger";

const execFileAsync = promisify(execFile);

// Collapse any still stretch to at most this many seconds. 0 removes dead air
// entirely: the frame-accurate re-encode means we don't need a keyframe cushion,
// and the animated cursor keeps real interactions moving, so a motionless
// stretch carries no information worth keeping. (Overlays that must survive — a
// held caption — animate continuously so their frames never read as "still".)
export const MAX_STILL_SEC = 0;

// A freeze starting within this many seconds of t=0 counts as the pre-load
// segment and is dropped entirely instead of capped.
const LEADING_FREEZE_SEC = 1;

// freezedetect noise tolerance (0-1 mean-absolute-difference ratio). Decoded
// static segments of a Playwright screencast are byte-identical (diff 0), so
// this sits very low: real interaction motion — a typed word, the cursor
// gliding to its target, the click ripple, a held caption's gentle breathing —
// clears it and is kept, while a genuinely motionless stretch falls below it
// and is trimmed.
const FREEZE_NOISE = "0.0003";

// freezedetect's own minimum freeze duration (its `d`). Kept a small positive
// value, decoupled from MAX_STILL_SEC: at d=0 freezedetect reports the whole
// clip as one freeze and never marks where motion resumes, so everything gets
// cut. A small floor lets it emit freeze_start/end around real motion while
// MAX_STILL_SEC=0 still trims each detected still to nothing. Stills shorter
// than this are imperceptible and left alone.
const FREEZE_MIN_SEC = 0.4;

// Don't bother re-encoding to save less than this many seconds.
const MIN_SAVINGS_SEC = 1;

const ANALYZE_TIMEOUT_MS = 60_000;
const ENCODE_TIMEOUT_MS = 300_000;

export interface Segment {
  end: number;
  start: number;
}

export interface FreezeAnalysis {
  durationSec: number;
  freezes: Segment[];
}

// Parse one freezedetect run: freeze_start/freeze_end pairs from stderr and
// the total decoded duration from `-progress` key=value output. A freeze that
// never ends (still at EOF) is closed at the total duration.
export function parseFreezeOutput(
  stderr: string,
  progress: string,
): FreezeAnalysis {
  let durationSec = 0;
  // -progress emits cumulative out_time_us (older builds: out_time_ms) lines;
  // the largest one is the total decoded duration.
  for (const match of progress.matchAll(/out_time_us=(\d+)/g)) {
    durationSec = Math.max(durationSec, Number(match[1]) / 1_000_000);
  }
  if (durationSec === 0) {
    for (const match of progress.matchAll(/out_time_ms=(\d+)/g)) {
      durationSec = Math.max(durationSec, Number(match[1]) / 1_000_000);
    }
  }

  const freezes: Segment[] = [];
  let open: number | undefined;
  const events = stderr.matchAll(
    /lavfi\.freezedetect\.freeze_(start|end):\s*([\d.]+)/g,
  );
  for (const [, kind, value] of events) {
    const t = Number(value);
    if (!Number.isFinite(t)) {
      continue;
    }
    if (kind === "start") {
      open = t;
    } else if (open !== undefined) {
      if (t > open) {
        freezes.push({ start: open, end: t });
      }
      open = undefined;
    }
  }
  if (open !== undefined && durationSec > open) {
    freezes.push({ start: open, end: durationSec });
  }
  return { durationSec, freezes };
}

// Given the detected freezes, compute the segments to KEEP. Every reported
// freeze is longer than maxStillSec (freezedetect's `d` threshold), so each
// one is capped to its first maxStillSec — except a leading freeze (the
// pre-page-load white frames), which is dropped entirely.
export function computeKeepSegments(
  analysis: FreezeAnalysis,
  maxStillSec: number = MAX_STILL_SEC,
): Segment[] {
  const { durationSec, freezes } = analysis;
  if (durationSec <= 0) {
    return [];
  }
  const cuts: Segment[] = [];
  for (const freeze of freezes) {
    if (freeze.start <= LEADING_FREEZE_SEC && cuts.length === 0) {
      cuts.push({ start: 0, end: freeze.end });
    } else {
      cuts.push({
        start: Math.min(freeze.start + maxStillSec, durationSec),
        end: freeze.end,
      });
    }
  }

  const keeps: Segment[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      keeps.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < durationSec) {
    keeps.push({ start: cursor, end: durationSec });
  }
  // Degenerate case (e.g. the whole video is one leading freeze): keep the
  // freeze's first maxStillSec rather than producing an empty file.
  if (keeps.length === 0) {
    return [{ start: 0, end: Math.min(maxStillSec, durationSec) }];
  }
  return keeps;
}

export function keptSeconds(keeps: Segment[]): number {
  return keeps.reduce((sum, k) => sum + (k.end - k.start), 0);
}

function selectExpression(keeps: Segment[]): string {
  return keeps
    .map((k) => `between(t,${k.start.toFixed(3)},${k.end.toFixed(3)})`)
    .join("+");
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function findFfmpegInCacheRoot(
  root: string,
): Promise<string | undefined> {
  const entries = (await listDir(root))
    .filter((entry) => entry.startsWith("ffmpeg-"))
    .sort()
    .reverse();
  for (const entry of entries) {
    for (const binary of await listDir(path.join(root, entry))) {
      const candidate = path.join(root, entry, binary);
      if (binary.startsWith("ffmpeg") && (await isExecutableFile(candidate))) {
        return candidate;
      }
    }
  }
  return;
}

// Playwright keeps its ffmpeg build in the browsers cache as
// <cache>/ffmpeg-<rev>/ffmpeg-<platform>[.exe].
async function findPlaywrightFfmpeg(): Promise<string | undefined> {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const found = await findFfmpegInCacheRoot(root);
    if (found) {
      return found;
    }
  }
  return;
}

export async function findFfmpeg(): Promise<string | undefined> {
  const override = process.env.CANARY_FFMPEG;
  if (override) {
    return (await isExecutableFile(override)) ? override : undefined;
  }
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(probe, ["ffmpeg"]);
    const found = stdout.split(/\r?\n/)[0]?.trim();
    if (found) {
      return found;
    }
  } catch {
    // not on PATH
  }
  return findPlaywrightFfmpeg();
}

async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stderr: string; stdout: string }> {
  const { stdout, stderr } = await execFileAsync(ffmpeg, args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export interface CondenseResult {
  condensed: boolean;
  durationSec?: number;
  keptSec?: number;
  reason?: string;
}

// Condense one video in place (write to a sibling tmp file, then rename over
// the original). Never throws — a failure keeps the original and reports why.
export async function condenseVideo(
  videoPath: string,
  log: Logger,
  ffmpegPath?: string,
): Promise<CondenseResult> {
  const tmpPath = `${videoPath}.condensed.webm`;
  try {
    const ffmpeg = ffmpegPath ?? (await findFfmpeg());
    if (!ffmpeg) {
      return { condensed: false, reason: "ffmpeg not found" };
    }
    await access(videoPath);

    const analyze = await runFfmpeg(
      ffmpeg,
      [
        "-hide_banner",
        "-nostats",
        "-i",
        videoPath,
        "-vf",
        `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_SEC}`,
        "-map",
        "0:v:0",
        "-an",
        "-progress",
        "pipe:1",
        "-f",
        "null",
        "-",
      ],
      ANALYZE_TIMEOUT_MS,
    );
    const analysis = parseFreezeOutput(analyze.stderr, analyze.stdout);
    if (analysis.durationSec <= 0) {
      return { condensed: false, reason: "could not determine duration" };
    }
    const keeps = computeKeepSegments(analysis);
    const keptSec = keptSeconds(keeps);
    if (analysis.durationSec - keptSec < MIN_SAVINGS_SEC) {
      return {
        condensed: false,
        durationSec: analysis.durationSec,
        keptSec,
        reason: "nothing to trim",
      };
    }

    await runFfmpeg(
      ffmpeg,
      [
        "-hide_banner",
        "-nostats",
        "-y",
        "-i",
        videoPath,
        "-vf",
        `select='${selectExpression(keeps)}',setpts=N/FRAME_RATE/TB`,
        "-an",
        "-c:v",
        "libvpx",
        "-b:v",
        "1M",
        tmpPath,
      ],
      ENCODE_TIMEOUT_MS,
    );
    const produced = await stat(tmpPath);
    if (produced.size === 0) {
      return { condensed: false, reason: "encoder produced an empty file" };
    }
    await rename(tmpPath, videoPath);
    return { condensed: true, durationSec: analysis.durationSec, keptSec };
  } catch (err) {
    log.debug({ err, videoPath }, "video condense failed; keeping original");
    return {
      condensed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(tmpPath, { force: true });
  }
}
