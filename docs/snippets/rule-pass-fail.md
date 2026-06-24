- Decide pass/fail ONLY against the flow's stated success criteria — the behavior you set out to
  verify. A step fails (exit non-zero, or log `FAIL`) when THAT behavior is wrong; otherwise it
  passes. The session is marked failed if any step's script exits non-zero, so reserve a non-zero
  exit / `FAIL` for a genuine criteria miss — not incidental noise.
- Console and page errors are captured as evidence, not verdicts. They DON'T by themselves fail a
  run — most are pre-existing noise (third-party scripts, analytics, unrelated warnings). Treat an
  error as a failure only when it IS the thing under test or actually blocks the flow.
- Same for the network: a non-2xx response (e.g. a 422 from form validation) is not a failure
  unless it's the behavior you're verifying. Expected validation, or an error on a field unrelated
  to the change, is not a regression — note it (`WARN`) and move on.
- When unsure, judge against intent — "did the thing I'm testing work?", not "did anything on the
  page emit an error?". Record incidental issues so a human can see them; don't fail the run on them.
