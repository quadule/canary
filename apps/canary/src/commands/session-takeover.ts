import { requestId } from "@usecanary/cli-kit";
import { ensureDaemonRunning, sendRequest } from "@usecanary/daemon-client";
import type {
  SessionTakeoverStartRequest,
  SessionTakeoverStopRequest,
} from "@usecanary/protocol";
import { readSessionRecord, updateSessionRecord } from "../session/registry.js";

interface TakeoverOpts {
  cancel?: boolean;
  step?: string;
  stop?: boolean;
}

interface TakeoverStopData {
  actionCount: number;
  code: string;
  durationMs: number;
  startedAt: number;
  step: string;
}

// Interactive takeover: hand the live headed browser to the user and capture
// their actions as generated Playwright source. Two phases the agent drives
// around the user's "I'm done" in chat — start (enable recorder) and --stop
// (disable, capture, record the step). No interactive stdin, so it works run
// over the wire as plain Bash calls.
export async function sessionTakeover(
  id: string,
  json: boolean,
  opts: TakeoverOpts = {}
): Promise<number> {
  const record = await readSessionRecord(id);
  if (record.status !== "active") {
    process.stderr.write(
      `Session "${id}" is ${record.status}; cannot record.\n`
    );
    return 1;
  }
  await ensureDaemonRunning();

  if (opts.stop || opts.cancel) {
    return await stopTakeover(id, json, Boolean(opts.cancel));
  }

  const request: SessionTakeoverStartRequest = {
    id: requestId("session-takeover-start"),
    type: "session-takeover-start",
    sessionId: id,
    step: opts.step ?? "manual-takeover",
    language: "javascript",
  };
  const code = await sendRequest(request, undefined);
  if (code === 0 && !json) {
    process.stdout.write(
      `Recording your actions on session "${id}". Take over the headed browser now — ` +
        `click, type, navigate as needed. When you're done, run:\n` +
        `  canary session takeover ${id} --stop\n` +
        "(or --cancel to discard).\n"
    );
  }
  return code;
}

async function stopTakeover(
  id: string,
  json: boolean,
  cancel: boolean
): Promise<number> {
  const request: SessionTakeoverStopRequest = {
    id: requestId("session-takeover-stop"),
    type: "session-takeover-stop",
    sessionId: id,
    cancel,
  };
  let result: TakeoverStopData | undefined;
  const code = await sendRequest(request, (data) => {
    result = data as TakeoverStopData;
  });
  if (code !== 0) {
    return code;
  }
  if (cancel) {
    if (!json) {
      process.stdout.write("Takeover cancelled; nothing recorded.\n");
    }
    return 0;
  }
  if (!result) {
    process.stderr.write("Takeover stopped but no result was returned.\n");
    return 1;
  }
  const captured = result;

  // Record the captured code as a session step so it lands in results.json /
  // the report alongside the trace + video of the takeover.
  await updateSessionRecord(id, (rec) => {
    rec.steps.push({
      durationMs: captured.durationMs,
      exitCode: 0,
      name: captured.step,
      ok: true,
      script: captured.code,
      startedAt: new Date(captured.startedAt).toISOString(),
    });
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(captured)}\n`);
  } else {
    process.stdout.write(
      `Captured ${captured.actionCount} action(s) as step "${captured.step}":\n\n${captured.code || "(no actions recorded)"}\n`
    );
  }
  return 0;
}
