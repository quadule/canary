# dailies-ui

> `dailies-viewer` — the local **session viewer** for [Dailies](https://github.com/quadule/dailies).
> Browse, search, organize, and replay recorded QA sessions (trace, video, network HAR, console,
> per-step screenshots) in your browser. Self-contained — no daemon, no setup.

[![npm](https://img.shields.io/npm/v/dailies-ui.svg)](https://www.npmjs.com/package/dailies-ui)
[![license](https://img.shields.io/npm/l/dailies-ui.svg)](https://github.com/quadule/dailies)

Like `npx playwright show-trace`, but for whole Dailies sessions: it spins up a local server, opens
your browser, and reads the artifacts that [`dailies-cli`](https://www.npmjs.com/package/dailies-cli)
wrote to `~/.dailies/sessions`.

## Use

```bash
npm i -g dailies-ui            # adds the `dailies-viewer` command
dailies-viewer                     # browse ~/.dailies/sessions, opens your browser

dailies-viewer --dir ./artifacts   # point at a non-default sessions folder
```

No global install? `npx dailies-ui`. Stop it with `Ctrl-C`.

The Dailies CLI also launches it for you — `dailies ui` is the same viewer.

## Options

| Flag | Effect |
| --- | --- |
| `--dir <path>` | Sessions folder to serve (default: `~/.dailies/sessions`). |
| `--port <port>` | Port to listen on (default: an open port). |
| `--host <host>` | Host/interface to bind. |
| `--no-open` | Start the server but don't open a browser (prints the URL). |

## What you can see

Each session opens to a report with everything captured during the run:

- **Steps** — every `dailies run --step` as an ordered entry, pass/fail, with its screenshot.
- **Trace** — the Playwright trace: DOM snapshots and actions, grouped per step.
- **Video** — a WebM recording of the run.
- **Network** — the HAR: every request/response, status, and timing.
- **Console** — console output and page errors.
- **Summary** — steps passed/failed, console errors, network failures, duration.

Search and organize across every recorded session from the index.

## Related packages

- [`dailies-cli`](https://www.npmjs.com/package/dailies-cli) — record the sessions this viewer
  displays.
- [`dailies-browser`](https://www.npmjs.com/package/dailies-browser) — one-off automation engine.
- [`create-dailies`](https://www.npmjs.com/package/create-dailies) — `npm create dailies` guided setup.

MIT · [source](https://github.com/quadule/dailies)
