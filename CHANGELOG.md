# Changelog

## Unreleased

### Added

- **Fixed-viewport recordings with an animated virtual cursor.** Sessions record at a fixed desktop
  viewport, and a synthetic cursor is drawn into the video (the OS pointer never appears under
  CDP-driven input): it glides to each target, shows a click ripple, and switches glyph
  (arrow / hand / I-beam) to match the element under it. Purely cosmetic — `pointer-events:none`,
  `aria-hidden`, invisible to `snapshotForAI`. Disable with `--no-cursor`.
- **Human-like interaction helpers** on the sandbox page — `page.humanClick(target)` and
  `page.humanFill(target, text)` (`target` is a selector or a locator). They reveal the element,
  glide the cursor onto it and let it settle, then act through real input (a true click; for fills,
  focus-then-type with real key events), so recordings read like a real user.
- **Video captions** — `page.showCaption(text, opts?)` overlays a short caption on the recording to
  label a moment for a human viewer.
- **`page.waitForSettled(opts?)`** — a bounded, framework-agnostic wait for the page to stop
  changing after a navigation (document load + DOM-mutation quiescence; watches the DOM, not the
  network, so it won't hang on long-lived connections).
- **Interactive session mode** — the `canary-session-interactive` skill and `/canary:session-interactive`
  command run a recorded session in the main conversation (no subagent): the agent drives
  autonomously but can pause to ask for direction, and can hand you the live headed browser for
  steps it can't do. `canary session takeover <id>` captures your manual actions via Playwright's
  recorder (api mode) as a step's generated Playwright source (`--stop` to record, `--cancel` to
  discard).
- **Condensed session videos** — when ffmpeg is available (PATH, `$CANARY_FFMPEG`, or Playwright's
  bundled copy) the pre-page-load segment is dropped and motionless stretches are trimmed via a
  frame-accurate re-encode, so reviewers don't scrub through dead air. `--no-condense` keeps raw
  recordings.
- **Unified steps panel** in the report — each step's screenshot is linked to and navigable from
  the step.
- `make install-local` — build, globally link the CLIs, and install the Claude Code plugin from a
  working checkout (for local development and dogfooding).
- Initial canary monorepo scaffold (pnpm + Turborepo).
- Bootstrapped from MIT-licensed upstream work by Sawyer Hood (see `LICENSE`). Migrated:
  - `cli-ts/` → `apps/canary-browser/` (browser engine CLI, bin: `canary-browser`)
  - `daemon/` → `apps/canary-daemon/` (internal Playwright host + QuickJS sandbox)
  - `daemon/src/protocol.ts` → `packages/protocol/` (Zod schemas, single source of truth)
- Shared `@usecanary/config` package (tsconfig bases).
- `@usecanary/logger` — shared pino-backed structured logging, used by the daemon
  (writes to `~/.canary/daemon.log`) and the CLI (stderr; `--verbose` /
  `CANARY_LOG_LEVEL`).
- [Ultracite](https://docs.ultracite.ai/) (Biome) for linting + formatting,
  enforced in CI; replaced Prettier and removed the unused eslint-config package.
- Dropped the Rust and Go CLI implementations and their docs entirely.

### Changed

- Agent guidance (skills, subagents, and the scripting reference) now mandates the human helpers
  for recorded clicks and text entry; directs clicking labels for checkboxes/radios (the real
  input is often hidden behind a custom control); checking for overlays/modals before interacting;
  settling and checking for changes (validation, new fields) before submitting a form; captioning
  only when it helps a viewer; and waiting for the page to settle after a navigation rather than
  acting on stale content.

### Fixed

- Viewer: a `--dir` (or `CANARY_UI_ROOT`) pointed at a single session directory now roots at its
  parent sessions folder instead of selecting an empty source — so opening a specific session from
  the review flow shows the sessions list rather than nothing.
