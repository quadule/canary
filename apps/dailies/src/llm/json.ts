// Reading JSON out of a model's reply, leniently.
//
// This is shared across every provider on purpose: the three backends are
// differently well-behaved — the `claude` CLI can wrap its answer in prose,
// an OpenAI-compatible endpoint with a json_schema response format returns
// clean JSON, and Apple's Foundation Models hands back a serialized
// GeneratedContent — but the failure modes overlap enough that one tolerant
// reader beats three strict ones.

export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

// Slice the FIRST balanced JSON object out of a string, tracking string/escape
// state so braces inside string values don't miscount. Returns null when there's
// no `{` or the object never closes (a truncated reply). Beats a naive
// firstOpen..lastClose: it survives a model preamble AND trailing prose that
// itself contains braces (which would otherwise drag `lastIndexOf("}")` past the
// real end). Pure → unit-tested.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a character-by-character scanner tracking string/escape/depth state — a state machine that reads worse when split.
export function extractBalancedJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Parse a model reply leniently: try the fence-stripped text, then fall back to
// the first balanced `{…}` so a chatty preamble ("Here's the narration:") doesn't
// abort the whole pass. Returns the parsed value or null.
export function tryParseJson(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to balanced-object extraction
  }
  const balanced = extractBalancedJson(stripped);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      return null;
    }
  }
  return null;
}

// A compact description of a reply that failed to parse: its length plus the
// head and (for a long reply) the tail — where truncation or trailing prose
// shows. Pure → unit-tested.
export function describeReply(raw: string): string {
  const s = raw.trim();
  if (!s) {
    return "empty output";
  }
  const head = s.slice(0, 140).replace(/\s+/g, " ");
  if (s.length <= 280) {
    return `${s.length} chars — ${head}`;
  }
  const tail = s.slice(-100).replace(/\s+/g, " ");
  return `${s.length} chars — starts: ${head}… ends: …${tail}`;
}
