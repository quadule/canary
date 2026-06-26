- No live user to ask here. Blocked by something only an operator can do (no login credentials, a
  feature flag, a settings change, manual setup)? Do NOT brute-force it, manufacture it (console /
  DB / API / seed), fake it, or silently skip it — that defeats the test. End the session so the
  report still captures what you got, then report exactly what blocked you, with the evidence — never
  fabricate a pass. If a human could unblock it, say the flow needs the interactive variant
  (canary-session-interactive), where someone can take over the live browser.
