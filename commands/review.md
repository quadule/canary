---
description: Open the Dailies session viewer and triage a recorded session.
argument-hint: "[session id or description]"
---

Delegate to the `review-agent` subagent.

If the user named a session ("$ARGUMENTS"), ask it to summarize that run from `results.json` and open
it. Otherwise, open the viewer (`npx dailies-ui`) and summarize the latest session.
