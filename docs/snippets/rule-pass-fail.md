- Decide pass/fail ONLY against the flow's stated success criteria — the behavior you set out to
  verify. YOU own the run's verdict: declare it when you finish with `session end --pass` or
  `session end --fail "<reason>"`. A failed INTERMEDIATE step is not a failed run — a click that
  timed out, a dead end you backed out of, or a retry you abandoned are honest evidence in the
  report but do NOT decide the outcome; only your declared verdict does. So don't contort the flow
  to keep every step green — take the obvious path, and if a step fails, recover and carry on, then
  judge the whole run at the end. (Declare no verdict and the run falls back to "failed if any step
  exited non-zero" — fine for a quick human run, but as the agent you should almost always declare.)
- Console and page errors are captured as evidence, not verdicts. They DON'T by themselves fail a
  run — most are pre-existing noise (third-party scripts, analytics, unrelated warnings). Treat an
  error as a failure only when it IS the thing under test or actually blocks the flow.
- Same for the network: a non-2xx response (e.g. a 422 from form validation) is not a failure
  unless it's the behavior you're verifying. Expected validation, or an error on a field unrelated
  to the change, is not a regression — note it (`WARN`) and move on.
- When unsure, judge against intent — "did the thing I'm testing work?", not "did anything on the
  page emit an error?". Record incidental issues so a human can see them; don't fail the run on them.
