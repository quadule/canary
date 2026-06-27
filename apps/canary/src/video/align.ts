// Align song-mode lyric captions to the ACTUAL sung vocals.
//
// ACE-Step doesn't sing our lyrics faithfully or on our schedule: it front-loads
// a long, variable instrumental intro, sings only some lines, and paces them
// itself. So to caption a generated song we transcribe it (whisper), find where
// the singing actually is, and place our CLEAN written lines at those times by
// fuzzy-matching them to the transcript (the user chose clean text over the
// transcript's mondegreens). Everything here is pure (no I/O) so it's unit-tested;
// the whisper subprocess + the trim/re-time live in narrate.ts.

// One transcript segment (a whisper cue): a time span and the words heard.
export interface Segment {
  start: number;
  end: number;
  text: string;
}

// One caption: our CLEAN line text, timed to the vocals it matched.
export interface TimedLine {
  start: number;
  end: number;
  text: string;
}

// Parse a whisper-cli `.srt` into segments. Drops non-lyrical cues (music stings
// and bare vocalizations like "(upbeat music)" / "♪ Oh ♪") so they don't get
// matched to a line. Tolerant of the `♪…♪` wrappers whisper adds to singing.
export function parseWhisperSrt(srt: string): Segment[] {
  const segments: Segment[] = [];
  const blocks = srt.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) {
      continue;
    }
    const m = timeLine.match(
      /(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)/
    );
    if (!m) {
      continue;
    }
    const start =
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const end =
      Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    const text = lines
      .slice(lines.indexOf(timeLine) + 1)
      .join(" ")
      .replace(/♪/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }
    // Drop sound-effect / non-lyrical cues: parenthesized stage directions, or a
    // bare filler vocalization with no real word.
    const cleaned = text.replace(/\([^)]*\)/g, "").trim();
    if (!cleaned || isFiller(cleaned)) {
      continue;
    }
    segments.push({ start, end, text: cleaned });
  }
  return segments;
}

// A cue that's just a filler vocalization (oh/ah/yeah/la/ooh/mmm), not a lyric.
function isFiller(text: string): boolean {
  const words = tokenize(text);
  if (words.length === 0) {
    return true;
  }
  const filler = new Set([
    "oh", "ah", "ooh", "ooo", "yeah", "yea", "la", "na", "mmm", "hmm", "whoa",
    "woah", "hey", "uh", "huh", "ohh", "ahh",
  ]);
  return words.every((w) => filler.has(w));
}

// Normalize to comparable word tokens: lowercase, strip punctuation/diacritics.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Similarity of two short texts in [0,1]. A blend of word-overlap (Jaccard) and a
// looser containment ratio, plus a character-bigram score so mondegreens ("soccer"
// vs "saga", "checkbook" vs "checkbox") still register. Pure → unit-tested.
export function similarity(a: string, b: string): number {
  const at = tokenize(a);
  const bt = tokenize(b);
  if (at.length === 0 || bt.length === 0) {
    return 0;
  }
  const aset = new Set(at);
  const bset = new Set(bt);
  let inter = 0;
  for (const w of aset) {
    if (bset.has(w)) {
      inter++;
    }
  }
  const jaccard = inter / (aset.size + bset.size - inter);
  const containment = inter / Math.min(aset.size, bset.size);
  const bigram = bigramScore(at.join(" "), bt.join(" "));
  // Weight word-level signal highest; bigram rescues near-miss homophones.
  return 0.45 * containment + 0.3 * jaccard + 0.25 * bigram;
}

// Dice coefficient over character bigrams of two strings (spaces collapsed).
function bigramScore(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const t = s.replace(/\s+/g, "");
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const [g, n] of ga) {
    inter += Math.min(n, gb.get(g) ?? 0);
  }
  let total = 0;
  for (const n of ga.values()) {
    total += n;
  }
  for (const n of gb.values()) {
    total += n;
  }
  return (2 * inter) / total;
}

// Align our ORDERED lyric `lines` to ACE-Step's ORDERED transcript `segments`,
// returning each MATCHED line's clean text timed to the vocals. Monotonic: a line
// only matches segments at/after the previously matched one, so order is kept;
// lines ACE-Step skipped are simply omitted (it sings only some). Consecutive
// segments that best-match the same line are merged into one cue (whisper often
// splits a line across cues). `minScore` rejects noise matches. Pure → tested.
export function alignLyricsToSegments(
  lines: string[],
  segments: Segment[],
  minScore = 0.18
): TimedLine[] {
  const out: TimedLine[] = [];
  // Index of the last line we committed; -1 before any match.
  let matched = -1;
  for (const seg of segments) {
    // Search from the just-matched line forward, so (a) a line split across
    // several whisper cues can re-match and extend, and (b) skipped lines are
    // passed over — but we never go backwards past what we've already shown.
    let bestIdx = -1;
    let bestScore = minScore;
    for (let i = Math.max(0, matched); i < lines.length; i++) {
      const s = similarity(seg.text, lines[i] ?? "");
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      continue; // no line matches this segment (e.g. an ad-libbed run)
    }
    const last = out.at(-1);
    if (last && bestIdx === matched && last.text === lines[bestIdx]) {
      // Same line continued across another cue → extend its window.
      last.end = seg.end;
      continue;
    }
    if (bestIdx <= matched) {
      continue; // would repeat/back up a line already shown; skip
    }
    out.push({ start: seg.start, end: seg.end, text: lines[bestIdx] ?? "" });
    matched = bestIdx;
  }
  return out;
}

// Group segments into runs separated by gaps larger than `maxGapSec`, and return
// the run with the most total sung time. ACE-Step sometimes sings one line early,
// then leaves a long instrumental gap before the main run — anchoring the trim on
// that early blip leaves a 20s+ intro. Trimming to the dominant cluster instead
// starts the video on the real singing (dropping the stray early line). Pure.
export function mainCluster(segments: Segment[], maxGapSec = 6): Segment[] {
  if (segments.length === 0) {
    return [];
  }
  const runs: Segment[][] = [];
  for (const seg of segments) {
    const run = runs.at(-1);
    const prev = run?.at(-1);
    if (run && prev && seg.start - prev.end <= maxGapSec) {
      run.push(seg);
    } else {
      runs.push([seg]);
    }
  }
  const sung = (run: Segment[]) =>
    run.reduce((acc, s) => acc + (s.end - s.start), 0);
  let best = runs[0] ?? [];
  for (const run of runs) {
    if (sung(run) > sung(best)) {
      best = run;
    }
  }
  return best;
}

// The span of the sung region: from a little before the first cue to a little
// after the last, clamped to >= 0. Returns null for no cues (caller then keeps
// the whole song / falls back). `lead`/`tail` pad so a word isn't clipped.
export function vocalRegion(
  segments: Segment[],
  opts: { lead?: number; tail?: number } = {}
): { start: number; end: number } | null {
  if (segments.length === 0) {
    return null;
  }
  const lead = opts.lead ?? 1.5;
  const tail = opts.tail ?? 1.5;
  const start = Math.max(0, (segments[0]?.start ?? 0) - lead);
  const end = (segments.at(-1)?.end ?? 0) + tail;
  return end > start ? { start, end } : null;
}
