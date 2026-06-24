import { stat } from "node:fs/promises";
import { formatDurationMs, requestId } from "@usecanary/cli-kit";
import {
  sendRequest,
  sessionReportPath,
  sessionResultsPath,
} from "@usecanary/daemon-client";
import type { SessionEndRequest, SessionEndResult } from "@usecanary/protocol";
import { logger } from "../logger.js";
import { writeSessionReport } from "../report/load-and-render.js";
import { endResultFromDisk } from "../session/artifacts.js";
import { readSessionRecord, updateSessionRecord } from "../session/registry.js";
import { condenseVideo, findFfmpeg } from "../video/condense.js";
import { stopDaemonIfIdle } from "./daemon-stop.js";

interface SessionEndOpts {
  condense?: boolean;
  stopDaemon?: boolean;
}

// Trim dead air from the recorded videos (pre-load white frames, long stills)
// before the report is rendered, refreshing each artifact's byte size so the
// manifest reflects the condensed file. Purely best-effort: without ffmpeg or
// on any failure, originals are kept and the report renders unchanged.
async function condenseSessionVideos(result: SessionEndResult): Promise<void> {
  const videos = result.artifacts.filter((a) => a.kind === "video");
  if (videos.length === 0) {
    return;
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    logger.info("ffmpeg not found; keeping raw session videos");
    return;
  }
  // Re-encoding can take a few seconds per video; without feedback the command
  // looks hung. Progress goes to stderr (stdout stays machine-readable).
  const label = videos.length === 1 ? "recording" : "recordings";
  process.stderr.write(`Condensing ${videos.length} ${label}…\n`);
  for (const video of videos) {
    const outcome = await condenseVideo(video.path, logger, ffmpeg);
    if (outcome.condensed) {
      video.bytes = await stat(video.path)
        .then((s) => s.size)
        .catch(() => video.bytes);
      const from = formatDurationMs(
        Math.round((outcome.durationSec ?? 0) * 1000)
      );
      const to = formatDurationMs(Math.round((outcome.keptSec ?? 0) * 1000));
      process.stderr.write(`  ✓ ${from} → ${to}\n`);
      logger.info({ video: video.path }, `condensed video: ${from} → ${to}`);
    } else {
      logger.debug(
        { video: video.path, reason: outcome.reason },
        "video left unchanged"
      );
    }
  }
}

export async function sessionEnd(
  id: string,
  json: boolean,
  opts: SessionEndOpts = {}
): Promise<number> {
  await readSessionRecord(id); // friendly "No such session" if unknown

  const request: SessionEndRequest = {
    id: requestId("session-end"),
    type: "session-end",
    sessionId: id,
    reason: "end",
  };
  let result: SessionEndResult | undefined;
  let code = 1;
  try {
    code = await sendRequest(request, (data) => {
      result = data as SessionEndResult;
    });
  } catch (err) {
    // Daemon unreachable (e.g. it was stopped). Fall through to reconcile the
    // record and finalize a report from whatever artifacts are on disk.
    logger.warn(
      { err, sessionId: id },
      "daemon unreachable; finalizing from on-disk artifacts"
    );
  }

  // Reconcile the on-disk record regardless of the daemon outcome: if the daemon
  // restarted / lost the session, never leave a zombie "active" record behind.
  const record = await updateSessionRecord(id, (r) => {
    if (r.status === "active") {
      r.status = "ended";
    }
    r.endedAt = new Date(result?.session.endedAt ?? Date.now()).toISOString();
  });

  // Degraded = the daemon did not cleanly finalize the live session (it was
  // unreachable, restarted, or returned an error), so the report is rebuilt
  // from whatever artifacts were already flushed to disk and may be partial.
  let degraded = code !== 0 || !result;
  if (degraded) {
    logger.warn(
      { sessionId: id },
      "daemon could not finalize the session; building the report from on-disk artifacts"
    );
  }
  const endResult =
    code === 0 && result ? result : await endResultFromDisk(record);

  if (opts.condense !== false) {
    await condenseSessionVideos(endResult);
  }

  // Resilient like `session abort`: a report-write failure must not crash the
  // command after the record was already flipped to "ended" (it can be rebuilt
  // by re-running `session end`, which is idempotent on an ended record).
  try {
    await writeSessionReport(id, record, endResult);
  } catch (err) {
    degraded = true;
    logger.warn({ err, sessionId: id }, "failed to write the session report");
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          artifactsDir: endResult.session.artifactsDir,
          artifacts: endResult.artifacts,
          reportPath: sessionReportPath(id),
          resultsPath: sessionResultsPath(id),
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(
      `Session ${id} ended.\nArtifacts: ${endResult.session.artifactsDir}\nReport:    ${sessionReportPath(id)}\n`
    );
  }

  if (opts.stopDaemon) {
    await stopDaemonIfIdle(id, json);
  }
  // Surface a non-zero exit when the daemon could not cleanly finalize the
  // session (or the report failed to write), so a CI wrapper can distinguish a
  // clean end from a degraded reconcile. The report is still written either way.
  if (degraded) {
    return code === 0 ? 1 : code;
  }
  return 0;
}
