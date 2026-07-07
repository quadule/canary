// Choosing what to caption a generated song with, and where the singing actually is.
//
// ACE-Step neither sings our lyrics on a fixed schedule nor always faithfully, so a
// generated song has three possible timing sources of decreasing quality:
//   1. the model's OWN per-line LRC timestamps (best — its alignment of the exact
//      lyrics it sang), guarded against implausible tail-clustering and floored by
//      transcribed word-onsets so a line never reveals before it's heard;
//   2. WORD-level alignment of our lines to a transcript's word timeline;
//   3. SEGMENT-level fuzzy matching.
// This module picks the best available source and returns the vocal region + the
// timed lines (in the raw-song timebase). It's pure given an already-fetched
// transcript, so the whole priority ladder is unit-testable in isolation.
import {
  alignLyricsToSegments,
  alignLyricsToWords,
  layoutAlignedCues,
  mainCluster,
  mergeLrcWithWordOnsets,
  parseLrc,
  redistributeImplausibleCues,
  type Segment,
  type TimedLine,
  type TimedWord,
  vocalRegion,
  vocalRegionExcludingTail,
} from "./align.js";

export interface SongCaptionPlan {
  // The sung region [start, end] to trim the song/body to, or null when no source
  // produced usable timing (caller falls back to step-timed captions).
  region: { start: number; end: number } | null;
  // The timed lyric lines, in the RAW-song timebase (the caller rebases to the trim).
  clipCues: TimedLine[];
  // Human-readable source, for the render note (empty when region is null).
  sourceLabel: string;
}

// The vocal region spanning a set of aligned lines: from a `leadSec` lead-in before
// the first sung line to a short tail after the last.
function anchorSpan(
  aligned: { start: number | null; end: number | null }[],
  leadSec: number
): { start: number; end: number } | null {
  const anchors = aligned.filter((a) => a.start !== null && a.end !== null);
  if (anchors.length === 0) {
    return null;
  }
  const first = Math.min(...anchors.map((a) => a.start ?? 0));
  const last = Math.max(...anchors.map((a) => a.end ?? 0));
  return { start: Math.max(0, first - leadSec), end: last + 1.5 };
}

// Resolve the caption source + vocal region for one generated song. Pure — the
// transcript (`segments`/`words`) is fetched by the caller. `leadSec` is the pre-line
// lead (title offset + a beat); `maxCueSec` caps a single cue. `useLrc:false` forces
// the transcribe path even when LRC is present.
export function selectSongCaptions(args: {
  orderedTexts: string[];
  lrcText?: string;
  useLrc?: boolean;
  segments: Segment[];
  words: TimedWord[];
  leadSec: number;
  maxCueSec: number;
}): SongCaptionPlan {
  const { orderedTexts, segments, words, leadSec, maxCueSec } = args;
  const useLrc = args.useLrc !== false;
  const lrcSegs = args.lrcText && useLrc ? parseLrc(args.lrcText) : [];
  const wordAligned =
    words.length > 0 ? alignLyricsToWords(orderedTexts, words) : [];
  const layout = { maxCueSec, minDurSec: 1.3 };

  // 1. LRC (guarded + onset-floored).
  let lrcCues =
    lrcSegs.length > 0 ? alignLyricsToSegments(orderedTexts, lrcSegs) : [];
  if (lrcCues.length > 0) {
    const vocalEnd =
      vocalRegionExcludingTail(segments, { lead: 0, tail: 0 })?.end ?? 0;
    lrcCues = redistributeImplausibleCues(lrcCues, vocalEnd);
    const merged = mergeLrcWithWordOnsets(orderedTexts, lrcCues, wordAligned);
    const region = anchorSpan(merged, leadSec);
    if (region) {
      return {
        region,
        clipCues: layoutAlignedCues(merged, {
          regionStart: region.start,
          regionEnd: region.end,
          ...layout,
        }),
        sourceLabel:
          wordAligned.length > 0
            ? "the model's lyric timestamps, onset-synced to the vocals"
            : "the model's own lyric timestamps",
      };
    }
  }

  // 2. Word-level alignment.
  if (wordAligned.length > 0) {
    const region = anchorSpan(wordAligned, leadSec);
    if (region) {
      return {
        region,
        clipCues: layoutAlignedCues(wordAligned, {
          regionStart: region.start,
          regionEnd: region.end,
          ...layout,
        }),
        sourceLabel: "the detected vocals, word-timed",
      };
    }
  }

  // 3. Segment fuzzy-match.
  if (segments.length > 0) {
    const region =
      vocalRegionExcludingTail(segments, { lead: leadSec, tail: 1.5 }) ??
      vocalRegion(mainCluster(segments), { lead: leadSec, tail: 1.5 });
    return {
      region,
      clipCues: alignLyricsToSegments(orderedTexts, segments),
      sourceLabel: "the detected vocals",
    };
  }

  return { region: null, clipCues: [], sourceLabel: "" };
}
