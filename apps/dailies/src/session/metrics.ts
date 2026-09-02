// Named numbers recorded against a session, and compared across runs.
//
// A session can carry measurements Dailies didn't take: a coverage percentage,
// a Lighthouse score, a bundle size. Dailies stores and reports them without
// knowing what any of them mean — `--metric coverage=42.5` is a number with a
// label, and that is the whole contract. Keeping it generic is deliberate: the
// alternative is a `--coverage` flag, and then a coverage subsystem.
//
// The comparison across runs is the point. A single coverage number is weak
// signal; the same number moving from 61% to 3% is a strong one, and usually
// means the recording broke rather than that the code got worse.

export interface Metric {
  name: string;
  value: number;
}

// `name=value`, where value parses as a finite number. Returns null for
// anything else so the caller can reject the flag with a useful message rather
// than silently recording a NaN. Pure → unit-tested.
export function parseMetric(raw: string): Metric | null {
  const at = raw.indexOf("=");
  if (at <= 0) {
    return null;
  }
  const name = raw.slice(0, at).trim();
  const rest = raw.slice(at + 1).trim();
  // Tolerate a trailing % — `coverage=42.5%` is the obvious thing to type.
  const value = Number(rest.replace(/%$/, ""));
  if (!(name && rest && Number.isFinite(value))) {
    return null;
  }
  return { name, value };
}

// Parse many, reporting the ones that didn't. Pure → unit-tested.
export function parseMetrics(raws: string[]): {
  invalid: string[];
  metrics: Metric[];
} {
  const metrics: Metric[] = [];
  const invalid: string[] = [];
  for (const raw of raws) {
    const parsed = parseMetric(raw);
    if (parsed) {
      // Last wins, so a repeated name is an override rather than a duplicate.
      const existing = metrics.findIndex((m) => m.name === parsed.name);
      if (existing >= 0) {
        metrics[existing] = parsed;
      } else {
        metrics.push(parsed);
      }
    } else {
      invalid.push(raw);
    }
  }
  return { invalid, metrics };
}

// How small a change counts as none. 1e-6 of a percentage point is below any
// real measurement's resolution, and well below float noise from summing.
const NEGLIGIBLE = 1e-6;

// Display decimals. Four is not arbitrary: on an application with a few hundred
// thousand executable lines, one line is ~0.0002% of the total, so four decimals
// is the granularity at which a single line of movement is still visible. Fewer
// (one decimal, as this first shipped) reports every run on a large codebase as
// unchanged; more is noise.
const DISPLAY_DECIMALS = 4;

// Format a number for display. Trailing zeros are dropped, so an integer reads
// as "42", 61.23 keeps both digits, and a hundredths-scale move survives.
// Pure → unit-tested.
export function formatValue(value: number): string {
  // toFixed then back through Number strips trailing zeros and clamps the float
  // tail (0.020000000000000018 -> 0.02) without inventing precision.
  return String(Number(value.toFixed(DISPLAY_DECIMALS)));
}

// One metric rendered against its previous value, e.g. "coverage 42.5 (+3.2
// since 39.3)". A first run has nothing to compare to and says so. Pure →
// unit-tested.
export function formatMetric(current: Metric, previous?: Metric): string {
  const now = formatValue(current.value);
  if (!previous) {
    return `${current.name} ${now} (first run)`;
  }
  const delta = current.value - previous.value;
  if (Math.abs(delta) < NEGLIGIBLE) {
    return `${current.name} ${now} (unchanged)`;
  }
  const sign = delta > 0 ? "+" : "−";
  return `${current.name} ${now} (${sign}${formatValue(Math.abs(delta))} since ${formatValue(previous.value)})`;
}

// Serialize into the workflow's PR-comment marker, e.g. "coverage=61.2345".
// Sorted so a marker is stable regardless of flag order.
//
// Deliberately NOT formatValue: the marker is what the NEXT run subtracts from,
// so rounding here would coarsen the stored value permanently and make every
// later delta drift. Display precision is a display concern. Pure → unit-tested.
export function serializeMetrics(metrics: Metric[]): string {
  return [...metrics]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => `${m.name}=${m.value}`)
    .join(" ");
}

// Read metrics back out of a marker's trailing text. Tolerant: unknown tokens
// are ignored, so an older marker with no metrics parses as none, and a newer
// marker with extra fields still yields what it can. Pure → unit-tested.
export function deserializeMetrics(text: string): Metric[] {
  const out: Metric[] = [];
  for (const token of text.trim().split(/\s+/)) {
    const parsed = parseMetric(token);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

// The lines for a PR comment: one per metric, each against its previous value.
// Metrics that only appeared previously are dropped — a measurement that
// stopped being taken isn't a regression to report. Pure → unit-tested.
export function formatMetricLines(
  current: Metric[],
  previous: Metric[]
): string[] {
  const before = new Map(previous.map((m) => [m.name, m]));
  return [...current]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => formatMetric(m, before.get(m.name)));
}
