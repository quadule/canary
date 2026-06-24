# Claude / Agent Instructions

See [`AGENTS.md`](AGENTS.md) for project orientation, architecture, and validation steps.

## Driving a browser

Every browser interaction in this repo goes through Canary's own CLI — `canary` / `canary-browser`
(or `npx @usecanary/cli` / `npx @usecanary/browser`) and the scripts it runs. Do **not** use Claude
in Chrome, a computer-use / screenshot tool, or any other browser automation to navigate, click,
fill, read, or view a page here — those bypass Canary's sandbox, the on-screen cursor, and the
trace / video / HAR / report capture, so the run isn't recorded or verifiable. To QA or automate a
flow, use the Canary skills (`canary-session`, `canary-automate`, `canary-verify`,
`canary-session-interactive`); to view a recorded session, use `canary-review`. If you catch
yourself reaching for another browser tool, stop and use Canary instead.
