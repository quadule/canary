# Agent Orientation

This file is the entry point for AI agents (and humans new to the repo).

## What dailies is

Dailies is an AI-agent QA toolkit for driving real browsers. The pieces:

1. **`dailies` (orchestrator CLI, `dailies-cli`)** — records capture-enabled QA sessions (trace/video/HAR/console) as a series of script steps and renders a self-contained report. The primary, user-facing CLI.
2. **`dailies-browser` (engine CLI, `dailies-browser`)** — one-off browser automation: persistent named pages, sandboxed JavaScript, headless or headed. Embeds and supervises the daemon.
3. **`dailies-daemon`** — a long-running Node process owning Playwright + a QuickJS sandbox. Embedded into the CLIs at build time. Speaks line-delimited JSON over a named pipe / Unix socket.
4. **`dailies-ui` (`dailies-ui`)** — the local session viewer; ships standalone. Run it with `dailies-viewer` (after `npm i -g dailies-ui`), or `dailies ui` from a repo checkout, or one-off via `npx dailies-ui`.

Both CLIs reach the browser the same way:

```
dailies run … --session …   /   dailies-browser run …   →   daemon RPC   →   Playwright
```

**Drive browsers only through these CLIs.** All browser work in this repo — navigating, clicking,
filling, scraping, viewing a recorded run — goes through the `dailies` / `dailies-browser` CLIs and
the scripts they run. Do not use Claude in Chrome, a computer-use tool, or any other browser
automation: they skip Dailies's sandbox, on-screen cursor, and trace/video/HAR/report capture, so
the run isn't recorded or verifiable.

## Apps + packages

| Workspace                | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/dailies`            | Session orchestrator CLI (`dailies`) — records QA sessions, renders reports. The primary CLI.    |
| `apps/dailies-browser`    | Browser-automation engine CLI (`dailies-browser`) — owns the daemon lifecycle, embeds the daemon |
| `apps/dailies-daemon`     | Internal Playwright host + QuickJS sandbox. Built standalone, embedded into the CLIs            |
| `apps/dailies-ui`         | Local web viewer (Astro + React islands). Reads `results.json`; run via `dailies ui` or `npx dailies-ui` |
| `apps/create-dailies`     | `npm create dailies` setup wizard (Ink)                                                          |
| `packages/protocol`      | Zod IPC schemas. Single source of truth — daemon validates, CLIs infer types                    |
| `packages/config`        | Shared tsconfig bases (`base`, `node-app`)                                                       |
| `packages/logger`        | Shared pino-backed structured logger (source-distributed)                                       |
| `packages/cli-kit`       | Shared CLI helpers (request ids, formatting, logger factory)                                    |
| `packages/daemon-client` | Daemon transport + lifecycle + paths; embeds the daemon bundle for the CLIs                     |

## Build flow

`turbo run build` topo-sorts via `^build`:

1. `dailies-protocol` + `dailies-config` + `dailies-logger` (no build, source-distributed)
2. `dailies-daemon` builds → emits `dist/daemon.bundle.mjs` + `dist/sandbox-client.js`
3. `dailies-browser` + `dailies-cli` embed their assets (the daemon bundle via `dailies-daemon-client`), then bundle with esbuild; `dailies-ui` builds an Astro node standalone — a self-contained `dist/server/entry.mjs` + `dist/client/` (`vite.ssr.noExternal` bundles every server dep, so the published package ships no runtime `node_modules`)

## Shared docs (skills + CLI help + README)

LLM-facing doc content that appears on more than one surface — the sandbox/scripting API and the
workflow rules — is single-sourced in `docs/snippets/` and stitched by `scripts/stitch-docs.mjs`:

- Edit the snippet, then run `make docs` (`--write`). CI fails on drift via `pnpm check` (`--check`).
- Never hand-edit `packages/cli-kit/src/snippets.generated.ts` or the content between
  `<!-- dailies:snippet … -->` markers in `skills/`, `agents/`, or `README.md`.
- `skills/` is the skill pack consumed verbatim by Claude Code (`.claude-plugin/`), Cursor
  (`.cursor-plugin/`), and Codex (`plugins/dailies/`, whose `skills` is a symlink here) — keep
  SKILL.md frontmatter (`name`, `description`) intact and marker-free.

## The `.dailies/` project convention

A repo that Dailies drives can commit what Dailies needs to know about it. Implemented in
`apps/dailies/src/project/config.ts`:

- `.dailies/flows.md` — app-specific knowledge for driving that app. Dailies never parses it; the
  **agent** reads it, because the `dailies-session` / `dailies-scripting` skills tell it to (see
  `docs/snippets/rule-project-flows.md`). That instruction is why this is a plain file rather than
  a per-app skill: skill loading depends on the model matching a `description`, and it only works
  in one harness. `session start` reports the file and warns past `FLOWS_LINE_BUDGET`.
- `.dailies/config.json` — machine-readable defaults (`url`, `demo.paths`, `demo.prompt`) consumed
  by `apps/dailies/src/ci/demo-request.ts`, which merges them with per-PR overrides from the PR body.

Both are optional and both fail open: a missing or malformed file yields defaults rather than
failing a run. `flows.md` becomes agent instructions, so treat it as untrusted when it comes from a
repo you don't control.

## Artifact sensitivity

A recorded session runs against a logged-in app, so its artifacts are not uniformly shareable:

- `report.html` and `results.json` are the shareable ones — no request headers in them.
- `network.har` has `Cookie` / `set-cookie` / `Authorization` **values** replaced at `session end`
  (see `apps/dailies/src/session/scrub-har.ts`; `--no-scrub-har` opts out). Response bodies are
  **not** scrubbed.
- `trace.zip` carries the same traffic unscrubbed, and `profile/` is a real Chrome cookie database.

So: attach or link `report.html`, never zip a whole session directory into a PR or a chat. Sessions
recorded before scrubbing landed still hold credentials in their HAR.

## Code style & logging

- **Linting/formatting:** [Ultracite](https://docs.ultracite.ai/) over Biome — config in `biome.jsonc` (extends `ultracite/biome/core`). `pnpm lint` checks; `pnpm format` autofixes; the pre-commit hook runs `ultracite fix` on staged files. Don't reintroduce ESLint/Prettier.
- **Logging:** use `dailies-logger` (`createLogger`, pino-backed, structured) for diagnostics — never `console.*` in app code (Biome's `noConsole` is an error). Reserve `process.stdout` for machine-readable CLI output. Level via `DAILIES_LOG_LEVEL` (trace|debug|info|warn|error|silent); the daemon logs to `~/.dailies/daemon.log`, the CLI to stderr (raise with `--verbose`).
- The vendored Playwright fork at `apps/dailies-daemon/src/sandbox/forked-client/` is excluded from lint/format — keep it diffable against upstream.

## Validation

Before committing:

```bash
pnpm install
pnpm check     # ultracite lint + turbo compile + test
```

Per-workspace:

```bash
pnpm --filter dailies-daemon test
pnpm --filter dailies-browser test
```

## Viewing sessions

`dailies ui` launches a local Astro web app (`apps/dailies-ui`, `dailies-ui` — the Library and
SessionView screens are client-only React islands) that reads each
session's `results.json`, lists every recorded session, and renders it in the same tabbed,
"High-Contrast Precision" layout as the self-contained HTML report. You can organize sessions
into **virtual folders**, tag/note/search them, and delete-to-trash. It reads `~/.dailies/sessions`
by default; `dailies ui --dir <path>` (or adding roots in the UI) points it elsewhere.

- Organization lives in a per-root `.dailies-ui.json` sidecar — **sessions stay flat on disk**;
  deletes move the dir to `<root>/.trash/` (restorable).
- The command resolves the built server (`dist/server/entry.mjs`) and spawns it in the foreground
  (Ctrl-C stops it); with no build present it falls back to `astro dev`. Build once for fast
  startup: `pnpm --filter dailies-ui build`. (The viewer stays a separate `node` server rather
  than folding into the esbuild/SEA CLI bundle — `DAILIES_UI_SERVER` overrides its location. The
  server reads `HOST`/`PORT`/`DAILIES_UI_ROOT` from the environment.)

## Provenance

Dailies's daemon and TypeScript CLIs (`dailies-daemon`, `dailies-browser`, and the `dailies` session orchestrator) are the core of the toolkit. Portions are derived from MIT-licensed upstream work by Sawyer Hood (see `LICENSE`).
