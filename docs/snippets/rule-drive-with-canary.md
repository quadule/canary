- Drive the browser only through Canary — the `{{cli}}` CLI and the scripts it runs. Do NOT use
  Claude in Chrome, a computer-use / screenshot tool, or any other browser automation to navigate,
  click, fill, or read a page, even for a single step. Those bypass Canary's sandbox, the on-screen
  cursor, and the trace / video / HAR capture, so nothing is recorded or verifiable. If a step
  tempts you toward another browser tool, write a Canary script instead.
