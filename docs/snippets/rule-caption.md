- Captions are the exception, not the rule — by default add NONE. The video already shows what's
  happening, so most steps need no caption. Reach for `await page.showCaption("…")` only when
  something genuinely non-obvious needs explaining for a human viewer: an off-happy-path
  precondition, WHY a step is being done, or what to watch for next. Never narrate the obvious or
  echo a step name — a caption that restates "Click Submit" is noise. Keep them short; they fade
  after a few seconds (pass `{ durationMs }` to adjust).
