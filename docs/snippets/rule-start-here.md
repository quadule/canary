- STOP — before your FIRST `{{cli}}` command (not just before writing a script), read the
  **canary-scripting** skill in full: invoke the canary-scripting skill (in this repo you can also
  open `skills/canary-scripting/SKILL.md`). It holds the script API and the interaction rules the
  rest of this skill relies on. Don't start a session without it.
- Follow the workflow's commands as written — don't run `--help` just to explore. Only when you
  need a specific flag and aren't sure of it, check `{{cli}} <command> --help` instead of guessing.
- Drive every recorded click and text entry with `page.humanClick` / `page.humanFill`, never raw
  `click` / `fill`. This is not optional.
- Reach a page by clicking the control a real user sees (e.g. the login button on the main login
  page), not by brute-forcing a hidden widget. If a step times out, STOP and take the obvious path
  instead of retrying the same dead end — and use `--timeout 10` so a wrong turn fails fast instead
  of burning 30s.
- After a click that navigates (Turbo / SPA especially), `page.url()` and the new content lag until
  the request lands — don't read them the instant the click returns. `await page.waitForURL(<url |
  regex>)` or `await page.waitForSettled()`, then read. Canary does track the new URL; it just isn't
  there immediately.
- A click returning is NOT success. Before you submit, confirm the submit control is enabled and
  every required field / checkbox is satisfied; afterward, verify the change actually persisted. A
  disabled or validation-blocked submit saved nothing — never report that run as passed.
