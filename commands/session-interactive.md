---
description: Record a Canary QA session collaboratively in this conversation (no subagent).
argument-hint: "[flow to record]"
---

Run the **canary-session-interactive** skill in THIS conversation — do NOT delegate to a subagent.

Drive the flow autonomously and record it step by step, but pause to ask the user in chat when the
next move is ambiguous, and hand them the live headed browser (via `canary session takeover <id>`)
for steps you can't do yourself — logging in, enabling a feature flag, changing settings. Capture
what they do as recorded steps, then carry on.

If the user described a flow ("$ARGUMENTS"), start there; otherwise ask what to record.
