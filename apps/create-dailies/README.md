# create-dailies

> The guided setup wizard for [Dailies](https://github.com/quadule/dailies) — an AI-agent QA toolkit
> that drives real browsers, records QA sessions (Playwright trace, video, network HAR, console), and
> renders self-contained verification reports.

[![npm](https://img.shields.io/npm/v/create-dailies.svg)](https://www.npmjs.com/package/create-dailies)
[![license](https://img.shields.io/npm/l/create-dailies.svg)](https://github.com/quadule/dailies)

One command to get Dailies and its browser runtime set up — no flags to remember. Every step just
shells out to the same published commands you could run by hand, so there's no magic and nothing
bespoke to uninstall. Agent integration (skills, Claude Code plugin) is deliberately left to you:
after setup the wizard prints the exact commands to run.

## Use

```bash
npm create dailies
# or:  npm init dailies  ·  pnpm create dailies  ·  yarn create dailies
```

You'll get a checklist (space toggles, enter confirms). Recommended items are pre-selected:

| Step | Default | What it runs |
| --- | --- | --- |
| Install the `dailies` command globally | ✓ | `npm i -g dailies-cli` |
| Install the browser runtime (Chromium) | ✓ | `dailies install` |
| Also install `dailies-browser` globally | — | `npm i -g dailies-browser` |
| Also install the `dailies-viewer` viewer globally | — | `npm i -g dailies-ui` |

Installing the CLIs globally puts `dailies`, `dailies-browser`, and `dailies-viewer` on your `PATH` so
day-to-day use drops the `npx` prefix. The wizard never installs the plugins itself — once setup
completes it prints the commands (Claude Code `/plugin …`, Cursor / Codex marketplace) so each
agent's own mechanism does the work.

### Non-interactive

In a pipe or CI (no TTY), the wizard prints the exact commands to run instead of prompting — safe to
inspect before executing.

## After setup

Add the agent integration yourself (one-time):

```bash
# Claude Code: /plugin marketplace add quadule/dailies  then  /plugin install dailies@dailies-marketplace
```

Then record a session:

```bash
dailies session start --name "checkout"   # start a recorded session (prints an id)
dailies run ./step.js --session <id> --step "open"
dailies session end <id>                  # -> ~/.dailies/sessions/<id>/report.html
dailies-viewer                            # browse recorded sessions
```

Using a coding agent? Try `/dailies:verify` (plan QA for your changes) or `/dailies:session` (record a
flow) in Claude Code / Cursor / Codex. See `examples/` in the repo for runnable demos.

## Related packages

- [`dailies-cli`](https://www.npmjs.com/package/dailies-cli) — the `dailies` session orchestrator.
- [`dailies-browser`](https://www.npmjs.com/package/dailies-browser) — one-off automation engine.
- [`dailies-ui`](https://www.npmjs.com/package/dailies-ui) — the `dailies-viewer` session browser.

MIT · [source](https://github.com/quadule/dailies)
