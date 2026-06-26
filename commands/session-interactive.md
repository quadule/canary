---
description: Record a Canary QA session collaboratively in this conversation (no subagent).
argument-hint: "[flow to record]"
allowed-tools:
  - Bash(canary:*)
  - Bash(canary-browser:*)
  - Bash(npx @usecanary/cli:*)
  - Bash(npx @usecanary/browser:*)
  - Bash(npx @usecanary/ui:*)
---

Your FIRST action is to load the **canary-session-interactive** skill with the Skill tool and
follow it. Do not run any `canary` command or take any other action before it is loaded — it holds
the full workflow and the non-negotiable rules below. Unlike the other Canary commands this one
does NOT delegate to a subagent: run it in THIS conversation, so the user can take over the live
headed browser for steps you can't do (logging in, enabling a feature flag, changing settings) and
you capture what they do as recorded steps.

The non-negotiables (the skill has the detail — these are here so they bind even before it loads):

<!-- canary:snippet rule-start-here cli=npx-cli -->
- STOP — before your FIRST `npx @usecanary/cli` command (not just before writing a script), read the
  **canary-scripting** skill in full: invoke the canary-scripting skill (in this repo you can also
  open `skills/canary-scripting/SKILL.md`). It holds the script API and the interaction rules the
  rest of this skill relies on. Don't start a session without it.
- Follow the workflow's commands as written — don't run `--help` just to explore. Only when you
  need a specific flag and aren't sure of it, check `npx @usecanary/cli <command> --help` instead of guessing.
- Drive every recorded click and text entry with `page.humanClick` / `page.humanFill`, never raw
  `click` / `fill`. This is not optional.
- Reach a page by clicking the control a real user sees (e.g. the login button on the main login
  page), not by brute-forcing a hidden widget. If a step times out, STOP and take the obvious path
  instead of retrying the same dead end — and use `--timeout 10` so a wrong turn fails fast instead
  of burning 30s.
- A click that navigates (Turbo / SPA especially) finishes asynchronously — the fetch lands, the DOM
  swaps, the URL updates — so don't read `page.url()` the instant the click returns (it's client-
  cached and lags a same-document Turbo nav until the nav commits). If you need the new URL in the
  SAME step, use the call that straddles the click: `const href = await
  page.humanClickAndWaitForURL(link)`. Otherwise you needn't wait — Canary settles the page at the
  end of every step, so the next step's fresh page is already on the committed, quiet destination.
- A click returning is NOT success. Before you submit, confirm the submit control is enabled and
  every required field / checkbox is satisfied; afterward, verify the change actually persisted. A
  disabled or validation-blocked submit saved nothing — never report that run as passed.
<!-- canary:end rule-start-here -->

If the user described a flow ("$ARGUMENTS"), record that; otherwise ask what to record.
