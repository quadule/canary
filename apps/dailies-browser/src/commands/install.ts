import { installDaemonRuntime } from "dailies-daemon-client";

// Install Playwright + runtime deps under ~/.dailies/. Delegates to the
// shared daemon-client implementation (same runtime the daemon embeds).
export function installRuntime(): Promise<number> {
  return installDaemonRuntime();
}
