- Captions explain what the video can't show on its own — use them sparingly and never to narrate
  the obvious. A caption that restates a step ("Click Submit") or echoes a step name is noise; skip
  it. Reach for `await page.showCaption("…")` when something a viewer can't infer from the screen
  needs saying: an off-happy-path precondition, WHY a step is being done, or what to watch for next.
- Especially caption a deviation from what was asked — when you improvise a workaround, set up a
  precondition, or take an unrequested path to reach the feature under test. In a non-interactive
  run no one is watching live, so a one-line "doing X because Y" is what tells a later viewer the
  detour was deliberate, not a mistake. Keep captions short; they fade after a few seconds (pass
  `{ durationMs }` to adjust).
