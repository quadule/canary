import { requestId } from "@usecanary/cli-kit";
import { ensureDaemonRunning, sendRequest } from "@usecanary/daemon-client";
import type { SessionUrlRequest } from "@usecanary/protocol";

interface UrlData {
  title: string;
  url: string;
}

// Read-only peek at a session's active page — prints the live URL (and title
// with --json). Fast, records nothing. Lets the agent check where it landed
// between steps (e.g. did that click navigate?) without a bookkeeping step,
// reading the committed URL straight from the page (no client-cache lag).
export async function sessionUrl(id: string, json: boolean): Promise<number> {
  await ensureDaemonRunning();

  const request: SessionUrlRequest = {
    id: requestId("session-url"),
    type: "session-url",
    sessionId: id,
  };

  let result: UrlData | undefined;
  const code = await sendRequest(request, (data) => {
    result = data as UrlData;
  });
  if (code !== 0) {
    return code;
  }
  if (!result) {
    process.stderr.write("No page info returned.\n");
    return 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    // Bare URL on its own line — easy for the agent (or a shell) to read.
    process.stdout.write(`${result.url}\n`);
  }
  return 0;
}
