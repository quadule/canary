// Pure caption/SRT helpers: SRT timestamp + document building, and the
// burned-caption word-wrap / truncation logic. No external dependencies.

// Burned-caption layout. The on-screen caption holds at most two lines; each is
// kept short enough (~48 chars) that, at the libass FontSize below, a line fits
// the frame width without libass re-wrapping it onto a third line. Narration
// longer than two lines is truncated with an ellipsis in the caption (the audio
// still speaks it in full); the prompt asks for short lines so that's rare.
const CAPTION_LINE_MAX = 48;
const CAPTION_MAX_LINES = 2;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// Format seconds as an SRT timestamp "HH:MM:SS,mmm" (comma before the
// milliseconds, all fields zero-padded). Handles sub-second and >1h values;
// negatives clamp to zero.
export function secToSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const seconds = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const minutes = totalMin % 60;
  const hours = Math.floor(totalMin / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(ms, 3)}`;
}

// Build a valid multi-cue SRT document from timed cues. Cue numbers are
// 1-based; each cue is "<n>\n<start> --> <end>\n<text>\n\n".
export function buildSrt(
  cues: { start: number; end: number; text: string }[],
  maxCharsPerLine = CAPTION_LINE_MAX
): string {
  return cues
    .map((cue, i) => {
      const start = secToSrtTimestamp(cue.start);
      const end = secToSrtTimestamp(cue.end);
      const text = wrapCaption(cue.text, maxCharsPerLine);
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join("\n");
}

// Caption chars-per-line scaled to the video width. The libass caption font
// doesn't shrink as fast as the frame, so a fixed budget that fits the 1280px
// default viewport overflows a narrow one. Calibrated against burned frames:
// 48 chars = two lines at 1280px, and a narrower frame needs proportionally
// fewer (~30 at 800px). Capped at CAPTION_LINE_MAX so a very wide video still
// keeps captions to a readable ~two short lines, and floored so a tiny viewport
// doesn't truncate to nothing.
export function captionLineMax(width: number | undefined): number {
  if (!width || width <= 0) {
    return CAPTION_LINE_MAX;
  }
  return Math.max(24, Math.min(CAPTION_LINE_MAX, Math.floor(width * 0.0375)));
}

function truncateWithEllipsis(line: string, limit: number): string {
  if (line.length + 1 <= limit) {
    return `${line}…`;
  }
  return `${line.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// Wrap caption text for burn-in so it never shows more than `maxLines` lines.
// Greedy word wrap at `maxCharsPerLine`; if the text needs more lines than that,
// the last line is truncated with an ellipsis. The explicit line breaks become
// libass `\N`, and because each line stays well within the frame width libass's
// own (smart) wrapping won't add a surprise extra line on top.
export function wrapCaption(
  text: string,
  maxCharsPerLine = CAPTION_LINE_MAX,
  maxLines = CAPTION_MAX_LINES
): string {
  const limit = Math.max(1, maxCharsPerLine);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    // `word` won't fit on the current line. If a new line would exceed the
    // budget, stop here — the leftover words get folded into an ellipsis.
    if (lines.length + 1 >= maxLines) {
      truncated = true;
      break;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  if (truncated) {
    lines[lines.length - 1] = truncateWithEllipsis(lines.at(-1) ?? "", limit);
  }
  return lines.join("\n");
}

// Strip inline caption override tags (`{...}`) from narration text before it's
// spoken or written to the report, leaving the plain words.
export function stripOverrideTags(text: string): string {
  return text.replace(/\{[^}]*\}/g, "").replace(/[{}]/g, "");
}
