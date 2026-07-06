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

// One transcript WORD with its own tight timing (whisperx's forced-alignment pass
// and large-v3-turbo servers emit these). `prob` is the aligner/ASR confidence in
// [0,1] when available — used to drop hallucinated words over instrumental music.
export interface TimedWord {
  start: number;
  end: number;
  word: string;
  prob?: number;
}

// One lyric line placed against the vocals by word-level alignment. `start`/`end`
// are null when no word matched the line (ACE-Step skipped it, or sang it too
// garbled to align) — the caller then interpolates it between neighbors or drops
// it. `support` is the fraction of the line's tokens that matched a sung word, the
// signal for "was this line actually sung?".
export interface AlignedLine {
  index: number;
  start: number | null;
  end: number | null;
  text: string;
  support: number;
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
    const cleaned = cleanSegmentText(
      lines.slice(lines.indexOf(timeLine) + 1).join(" ")
    );
    if (!cleaned) {
      continue;
    }
    segments.push({ start, end, text: cleaned });
  }
  return segments;
}

// Normalize a transcript cue's raw text to a lyric line, or null to drop it.
// Strips the `♪…♪` wrappers whisper adds to singing and the sound-effect / ASR
// non-speech markers in (parens) or [brackets] (e.g. "(upbeat music)",
// "[BLANK_AUDIO]"), and rejects bare filler vocalizations ("oh", "la"). Shared by
// the SRT parser and the OpenAI verbose_json mapper. Pure → unit-tested.
export function cleanSegmentText(raw: string): string | null {
  const text = raw.replace(/♪/g, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  const cleaned = text
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isFiller(cleaned)) {
    return null;
  }
  return cleaned;
}

// Map an OpenAI-compatible `verbose_json` transcription (whisper `/v1/audio/
// transcriptions`) into our Segment[]: each `segments[]` entry carries start/end
// (seconds) + text. Applies the same cleaning as the SRT parser. Tolerant of a
// missing/!array `segments` field. Pure → unit-tested.
export function segmentsFromOpenAI(body: unknown): Segment[] {
  const raw = (body as { segments?: unknown })?.segments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Segment[] = [];
  for (const entry of raw) {
    const seg = entry as { start?: unknown; end?: unknown; text?: unknown };
    if (
      typeof seg.start !== "number" ||
      typeof seg.end !== "number" ||
      typeof seg.text !== "string"
    ) {
      continue;
    }
    const cleaned = cleanSegmentText(seg.text);
    if (cleaned) {
      out.push({ start: seg.start, end: seg.end, text: cleaned });
    }
  }
  return out;
}

// Map an OpenAI-compatible `verbose_json` reply's WORD timestamps (requested with
// `timestamp_granularities[]=word`) into TimedWord[]. Tolerant of a missing/!array
// `words` field (a server that only returns segment granularity → empty). Pure.
export function wordsFromOpenAI(body: unknown): TimedWord[] {
  const raw = (body as { words?: unknown })?.words;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TimedWord[] = [];
  for (const entry of raw) {
    const w = entry as { start?: unknown; end?: unknown; word?: unknown };
    if (
      typeof w.start === "number" &&
      typeof w.end === "number" &&
      typeof w.word === "string" &&
      w.word.trim()
    ) {
      out.push({ start: w.start, end: w.end, word: w.word.trim() });
    }
  }
  return out;
}

// Parse whisperx's JSON output (`--output_format json`) into both segments (for
// region/tail detection) and the WORD timeline (for caption alignment — the tight
// forced-alignment timings that are whisperx's whole point). Shape:
// {segments:[{start,end,text,words:[{word,start,end,score}]}]}. A word whose
// start/end whisperx couldn't align (numerals, some symbols) is skipped. Pure.
export function parseWhisperxJson(json: unknown): {
  segments: Segment[];
  words: TimedWord[];
} {
  const rawSegs = (json as { segments?: unknown })?.segments;
  if (!Array.isArray(rawSegs)) {
    return { segments: [], words: [] };
  }
  const segments: Segment[] = [];
  const words: TimedWord[] = [];
  for (const entry of rawSegs) {
    const seg = entry as {
      start?: unknown;
      end?: unknown;
      text?: unknown;
      words?: unknown;
    };
    if (
      typeof seg.start === "number" &&
      typeof seg.end === "number" &&
      typeof seg.text === "string"
    ) {
      const cleaned = cleanSegmentText(seg.text);
      if (cleaned) {
        segments.push({ start: seg.start, end: seg.end, text: cleaned });
      }
    }
    if (Array.isArray(seg.words)) {
      for (const we of seg.words) {
        const w = we as {
          word?: unknown;
          start?: unknown;
          end?: unknown;
          score?: unknown;
        };
        if (
          typeof w.word === "string" &&
          w.word.trim() &&
          typeof w.start === "number" &&
          typeof w.end === "number"
        ) {
          words.push({
            start: w.start,
            end: w.end,
            word: w.word.trim(),
            prob: typeof w.score === "number" ? w.score : undefined,
          });
        }
      }
    }
  }
  return { segments, words };
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
    // ASR non-speech markers that can appear without brackets.
    "music", "silence", "blank", "audio", "applause", "inaudible", "noise",
    "instrumental",
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

// Align our ORDERED lyric `lines` to a flat, ordered WORD timeline (the primitive
// captioning should be built on — see the note below). Returns one entry PER input
// line: a line the singer actually sang gets vocal-accurate [start,end] and a
// `support` near 1; a line ACE-Step skipped gets start/end null and support 0.
//
// WHY WORDS, NOT SEGMENTS: ASR segment boundaries are guesses about *speech* and
// singing breaks every heuristic they use (no pauses, sustained vowels), so a
// transcriber routinely mashes several sung lines into one segment — matching our
// lines to segments then recovers only one of them. But the same transcriber's
// per-WORD timings are tight (whisperx runs a wav2vec2 forced-alignment pass for
// exactly this). Assigning each word to the lyric line it belongs to distributes a
// mashed blob back across its lines and needs no segment structure at all.
//
// Method: a MONOTONIC two-pointer over the flattened lyric-token stream. Each
// transcript word is matched to the nearest upcoming lyric token (within
// `lookahead` tokens, so a fully-unsung line or a garbled word is skipped without
// backing up), and the word's time is folded into that token's line. Low-confidence
// words (hallucinations over instrumental music) are dropped first. Pure → tested.
export function alignLyricsToWords(
  lines: string[],
  words: TimedWord[],
  opts: { wordSim?: number; lookahead?: number; minProb?: number } = {}
): AlignedLine[] {
  const wordSimMin = opts.wordSim ?? 0.6;
  const lookahead = opts.lookahead ?? 12;
  const minProb = opts.minProb ?? 0;

  // Match on CONTENT words only. Function words ("the", "a", "and", "is"…) recur
  // everywhere, so letting them match would let the monotonic pointer LEAP ahead
  // on a stray "the" and strand the lines in between (observed live: a whole sung
  // line scored zero because a repeated "the" jumped the pointer past it). Content
  // words anchor a line uniquely; a line's span from its content words is plenty.
  const isStop = (t: string): boolean => STOPWORDS.has(t);

  // Flatten every lyric CONTENT token, remembering which line it came from.
  const lyricTokens: { line: number; tok: string }[] = [];
  const lineTokenCount: number[] = [];
  lines.forEach((line, i) => {
    const content = tokenize(line).filter((t) => !isStop(t));
    lineTokenCount[i] = content.length;
    for (const tok of content) {
      lyricTokens.push({ line: i, tok });
    }
  });

  const acc = lines.map((text, index) => ({
    index,
    text,
    start: null as number | null,
    end: null as number | null,
    matched: new Set<number>(),
  }));

  // Usable words: real timings, high enough confidence, not a function word.
  const usable = words.filter(
    (w) =>
      Number.isFinite(w.start) &&
      Number.isFinite(w.end) &&
      w.end >= w.start &&
      (w.prob === undefined || w.prob >= minProb) &&
      !isStop(tokenize(w.word)[0] ?? "")
  );

  let p = 0; // pointer into lyricTokens (monotonic)
  for (const w of usable) {
    // Take the NEAREST acceptable match, not the highest-scoring one: a slightly
    // better token far downstream must not leap the pointer past unsung words.
    let hitJ = -1;
    const limit = Math.min(lyricTokens.length, p + lookahead);
    for (let j = p; j < limit; j++) {
      if (similarity(w.word, lyricTokens[j]?.tok ?? "") >= wordSimMin) {
        hitJ = j;
        break;
      }
    }
    if (hitJ < 0) {
      continue; // this word matches no upcoming lyric token — an ad-lib/insert
    }
    const line = lyricTokens[hitJ]?.line ?? 0;
    const a = acc[line];
    if (a) {
      a.start = a.start === null ? w.start : Math.min(a.start, w.start);
      a.end = a.end === null ? w.end : Math.max(a.end, w.end);
      a.matched.add(hitJ);
    }
    p = hitJ + 1;
  }

  return acc.map((a) => ({
    index: a.index,
    text: a.text,
    start: a.start,
    end: a.end,
    support: lineTokenCount[a.index]
      ? a.matched.size / (lineTokenCount[a.index] ?? 1)
      : 0,
  }));
}

// Common English function words — skipped when word-aligning lyrics so they can't
// hijack the monotonic pointer (see alignLyricsToWords). Deliberately small: only
// the highest-frequency, low-information words.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "to",
  "of", "in", "on", "at", "it", "its", "so", "as", "we", "i", "you", "he",
  "she", "they", "all", "by", "for", "with", "that", "this", "up", "out",
]);

// Rough syllable count for a lyric line — how long it needs to be sung. Counts
// vowel groups (with a small floor per word), which is close enough to size a
// caption's interpolated slot. Pure.
export function estimateSyllables(text: string): number {
  const words = tokenize(text);
  let total = 0;
  for (const w of words) {
    const groups = w.match(/[aeiouy]+/g)?.length ?? 0;
    total += Math.max(1, groups);
  }
  return Math.max(1, total);
}

// Turn per-line word-alignment results into final, non-overlapping caption cues,
// realizing the "every SUNG line, honest about skips" contract:
//   • a line with matched words → its exact vocal [start,end];
//   • a run of unmatched lines BETWEEN two anchors → interpolated across the gap by
//     syllable share, but ONLY if the gap is long enough to plausibly hold them
//     (`secPerSyllable`); otherwise the model skipped them and they're DROPPED —
//     burning a caption for an unsung line desyncs against what's actually heard;
//   • everything clamped to [regionStart, regionEnd], de-overlapped (a cue ends by
//     the next cue's start), floored to `minDurSec`, capped at `maxCueSec`.
// Cues come back sorted, ready to shift/burn. Pure → unit-tested.
export function layoutAlignedCues(
  aligned: AlignedLine[],
  opts: {
    regionStart?: number;
    regionEnd: number;
    minDurSec?: number;
    maxCueSec?: number;
    secPerSyllable?: number;
    minGapFactor?: number;
  }
): TimedLine[] {
  const regionStart = opts.regionStart ?? 0;
  const regionEnd = opts.regionEnd;
  const minDur = opts.minDurSec ?? 1;
  const maxCue = opts.maxCueSec ?? 8;
  const secPerSyllable = opts.secPerSyllable ?? 0.32;
  const minGapFactor = opts.minGapFactor ?? 0.55;

  // A matched line (has word timings) is an anchor; an unmatched one is a candidate
  // to interpolate or drop. `need` sizes its plausible sung length.
  const need = (line: AlignedLine): number =>
    Math.max(minDur, estimateSyllables(line.text) * secPerSyllable);

  const cues: TimedLine[] = [];
  let i = 0;
  let lastAnchorEnd = regionStart;
  while (i < aligned.length) {
    const line = aligned[i];
    if (!line) {
      i++;
      continue;
    }
    if (line.start !== null && line.end !== null) {
      cues.push({ start: line.start, end: line.end, text: line.text });
      lastAnchorEnd = line.end;
      i++;
      continue;
    }
    // Collect the run of consecutive unmatched lines [i, j).
    let j = i;
    while (j < aligned.length && aligned[j]?.start === null) {
      j++;
    }
    const run = aligned.slice(i, j);
    // The gap available: from the previous anchor's end to the next anchor's start
    // (or the region bounds at the edges).
    const nextAnchorStart = aligned[j]?.start ?? regionEnd;
    const gapStart = lastAnchorEnd;
    const gap = nextAnchorStart - gapStart;
    const needed = run.reduce((sum, r) => sum + need(r), 0);
    if (gap >= needed * minGapFactor && gap > 0) {
      // Interpolate: split the gap by each line's syllable share.
      let cursor = gapStart;
      const totalNeed = run.reduce((sum, r) => sum + need(r), 0) || 1;
      for (const r of run) {
        const slot = (need(r) / totalNeed) * gap;
        cues.push({ start: cursor, end: cursor + slot, text: r.text });
        cursor += slot;
      }
      lastAnchorEnd = cursor;
    }
    // else: the model skipped this run — drop it (no honest place to show it).
    i = j;
  }

  // Final pass: guarantee readable, non-overlapping cues. Walk in time order and
  // push each cue's start to at least the previous cue's end, then give it at least
  // `minDurSec` (capped at `maxCueSec` and the region). When the model sang two
  // lines almost on top of each other, this SPREADS them forward into the following
  // slack rather than stacking or crushing them to an unreadable flash — a small,
  // bounded desync in exchange for legibility. Because caller rebasing is a pure
  // time shift, this ordering holds in the final timeline too.
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const out: TimedLine[] = [];
  let prevEnd = regionStart;
  for (const cue of sorted) {
    const start = Math.max(Math.min(cue.start, regionEnd), prevEnd);
    if (start >= regionEnd) {
      break; // no room left on the timeline
    }
    const end = Math.min(regionEnd, start + maxCue, Math.max(cue.end, start + minDur));
    if (end <= start) {
      continue;
    }
    out.push({ start, end, text: cue.text });
    prevEnd = end;
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

// The region to KEEP, derived from the transcript's CONTENT novelty. Its purpose
// is to cut ACE-Step's repeated/sustained tail: to fill a (now duration-pinned)
// generation the model sings the written lines and then loops or holds the final
// line for the remainder. That tail is dead, droning air. This keeps the span from
// the first sung vocal to the end of the last segment that introduced NEW words —
// so a terminal loop (or a sustained final note transcribed as one line over and
// over) is dropped, while a chorus that repeats mid-song survives because novel
// verses still follow it.
//
// Working on the raw transcript (not our matched clean lines) makes this robust
// when ACE-Step sings the lyrics too garbled to fuzzy-match: the body still spans
// the real singing instead of collapsing to the handful of lines that happened to
// match. A segment counts as a repeat when it's `simThreshold`-similar to any
// earlier one. Returns null for no segments (caller falls back). Pure → tested.
export function vocalRegionExcludingTail(
  segments: Segment[],
  opts: { lead?: number; tail?: number; simThreshold?: number } = {}
): { start: number; end: number } | null {
  if (segments.length === 0) {
    return null;
  }
  const lead = opts.lead ?? 1.5;
  const tail = opts.tail ?? 1.5;
  const simThreshold = opts.simThreshold ?? 0.6;
  const seen: string[] = [];
  let lastNovelEnd = segments[0]?.end ?? 0;
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    const isRepeat =
      text !== "" && seen.some((prev) => similarity(prev, text) >= simThreshold);
    if (!isRepeat) {
      lastNovelEnd = Math.max(lastNovelEnd, seg.end);
    }
    if (text !== "") {
      seen.push(text);
    }
  }
  const start = Math.max(0, (segments[0]?.start ?? 0) - lead);
  const end = lastNovelEnd + tail;
  return end > start ? { start, end } : null;
}
