// Free stock music from the Internet Archive (archive.org) as a no-generation
// MusicProvider. Additive, same contract as the other providers (write a finished
// audio file to `outPath` or throw), wrapped in the caller's try/catch.
//
// WHY: ACE-Step generates music but needs a heavy local server; the Free Music
// Archive's public API is gone. archive.org has a real public API and a large
// pool of openly-licensed audio, so this is the light path — a quick search +
// download + trim, no model.
//
// LICENSING: results are constrained to the `netlabels` collection (curated
// Creative-Commons netlabel music) and to items that declare a `licenseurl`. The
// chosen track's title/creator/license/URL are surfaced in the provider notes so
// the run can attribute it (most CC licenses require attribution). Nothing is
// uploaded; only public GET requests are made.
//
// Unlike the generative providers, a downloaded track is an arbitrary length, so
// this provider trims it to the requested duration with ffmpeg (with a short
// fade-out) — otherwise an over-long bed would extend the final video.
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Logger } from "@usecanary/logger";
import type { MediaProviders, MusicProvider } from "./providers.js";

const execFileAsync = promisify(execFile);

const SEARCH_URL = "https://archive.org/advancedsearch.php";
const META_BASE = "https://archive.org/metadata";
const DL_BASE = "https://archive.org/download";
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TRIM_TIMEOUT_MS = 120_000;
// How many top hits to choose among (a little variety without drifting off-theme).
const SEARCH_ROWS = 25;

type Echo = (line: string) => void;

export interface ArchiveTrack {
  identifier: string;
  title: string;
  creator?: string;
  licenseurl?: string;
}

// Strip Lucene-significant characters from the free-text direction so it can be
// dropped into a query clause safely, and cap length. Pure → unit-tested.
export function sanitizeQuery(directionText: string): string {
  return directionText
    .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// Build the advancedsearch.php URL. Constrains to CC netlabel audio that declares
// a license; sorts by downloads so popular (usually higher-quality) tracks come
// first. `instrumental` biases the text toward beds. Pure → unit-tested.
export function buildSearchUrl(
  directionText: string,
  instrumental: boolean
): string {
  const terms = sanitizeQuery(directionText);
  const focus = instrumental ? `${terms} instrumental` : terms;
  const q = `(${focus}) AND mediatype:audio AND collection:netlabels AND licenseurl:[* TO *]`;
  const params = new URLSearchParams({
    q,
    sort: "downloads desc",
    rows: String(SEARCH_ROWS),
    output: "json",
  });
  // fl[] must repeat per field; URLSearchParams handles that via append.
  for (const f of ["identifier", "title", "creator", "licenseurl"]) {
    params.append("fl[]", f);
  }
  return `${SEARCH_URL}?${params.toString()}`;
}

// Parse the advancedsearch response into tracks. Pure → unit-tested.
export function parseSearchDocs(body: unknown): ArchiveTrack[] {
  const docs = (body as { response?: { docs?: unknown } })?.response?.docs;
  if (!Array.isArray(docs)) {
    return [];
  }
  const tracks: ArchiveTrack[] = [];
  for (const d of docs) {
    const id = (d as { identifier?: unknown }).identifier;
    if (typeof id !== "string") {
      continue;
    }
    const titleRaw = (d as { title?: unknown }).title;
    const creatorRaw = (d as { creator?: unknown }).creator;
    const licRaw = (d as { licenseurl?: unknown }).licenseurl;
    tracks.push({
      identifier: id,
      title: typeof titleRaw === "string" ? titleRaw : id,
      creator:
        typeof creatorRaw === "string"
          ? creatorRaw
          : Array.isArray(creatorRaw) && typeof creatorRaw[0] === "string"
            ? creatorRaw[0]
            : undefined,
      licenseurl:
        typeof licRaw === "string"
          ? licRaw
          : Array.isArray(licRaw) && typeof licRaw[0] === "string"
            ? licRaw[0]
            : undefined,
    });
  }
  return tracks;
}

// Pick a playable audio file name from an item's metadata, preferring an MP3.
// Pure → unit-tested.
export function pickAudioFile(body: unknown): string | null {
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return null;
  }
  const named = files
    .map((f) => (f as { name?: unknown }).name)
    .filter((n): n is string => typeof n === "string");
  const mp3 = named.find((n) => /\.mp3$/i.test(n));
  return mp3 ?? named.find((n) => /\.(ogg|flac|m4a|wav)$/i.test(n)) ?? null;
}

// A human attribution line for the provider notes. Pure → unit-tested.
export function attributionFor(track: ArchiveTrack): string {
  const who = track.creator ? ` by ${track.creator}` : "";
  const lic = track.licenseurl ? ` (${track.licenseurl})` : "";
  return `music: "${track.title}"${who}${lic} — https://archive.org/details/${track.identifier}`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`archive.org GET ${res.status}`);
  }
  return res.json();
}

// Download a URL to a path (streamed to a Buffer; tracks are a few MB).
async function downloadTo(
  url: string,
  outPath: string,
  timeoutMs: number
): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`archive.org download ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("archive.org returned 0 bytes");
  }
  await writeFile(outPath, bytes);
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface ArchiveDeps {
  ffmpeg: string;
  echo?: Echo;
  log: Logger;
  notes: string[];
  // Injectable for tests; defaults to Math.random.
  random?: () => number;
}

// Trim `src` to `seconds` with a 2s fade-out and write `outPath` (wav by ext).
async function trimTo(
  ffmpeg: string,
  src: string,
  seconds: number,
  outPath: string,
  echo?: Echo
): Promise<void> {
  const dur = Math.max(1, Math.round(seconds));
  const fadeStart = Math.max(0, dur - 2);
  const args = [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    src,
    "-t",
    String(dur),
    "-af",
    `afade=t=out:st=${fadeStart}:d=2`,
    "-ac",
    "2",
    "-ar",
    "44100",
    outPath,
  ];
  echo?.(`$ ${[ffmpeg, ...args].map(sq).join(" ")}`);
  await execFileAsync(ffmpeg, args, {
    timeout: TRIM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Fetch a themed track and write `seconds` of it to `outPath`. Surfaces the
// track's attribution in `notes` once.
async function fetchTrack(args: {
  deps: ArchiveDeps;
  directionText: string;
  seconds: number;
  instrumental: boolean;
  outPath: string;
}): Promise<void> {
  const { deps, directionText, seconds, instrumental, outPath } = args;
  const { ffmpeg, echo } = deps;
  const random = deps.random ?? Math.random;

  const searchUrl = buildSearchUrl(directionText, instrumental);
  echo?.(`$ curl -s ${sq(searchUrl)}`);
  const tracks = parseSearchDocs(await getJson(searchUrl, SEARCH_TIMEOUT_MS));
  if (tracks.length === 0) {
    throw new Error("no archive.org tracks matched");
  }
  // Pick among the top hits for a little variety run-to-run.
  const track = tracks[Math.floor(random() * tracks.length)] ?? tracks[0];
  if (!track) {
    throw new Error("no archive.org track selected");
  }

  const metaUrl = `${META_BASE}/${track.identifier}`;
  const file = pickAudioFile(await getJson(metaUrl, SEARCH_TIMEOUT_MS));
  if (!file) {
    throw new Error(`no audio file in ${track.identifier}`);
  }

  const dlUrl = `${DL_BASE}/${track.identifier}/${encodeURIComponent(file)}`;
  const raw = `${outPath}.src`;
  echo?.(`$ curl -sL ${sq(dlUrl)} -o ${sq(raw)}`);
  try {
    await downloadTo(dlUrl, raw, DOWNLOAD_TIMEOUT_MS);
    await trimTo(ffmpeg, raw, seconds, outPath, echo);
    deps.notes.push(attributionFor(track));
  } finally {
    await rm(raw, { force: true });
  }
}

function createMusicProvider(deps: ArchiveDeps): MusicProvider {
  return {
    id: "archive-music",
    bed: (directionText, seconds, outPath) =>
      fetchTrack({ deps, directionText, seconds, instrumental: true, outPath }),
    song: (directionText, seconds, outPath) =>
      fetchTrack({ deps, directionText, seconds, instrumental: false, outPath }),
  };
}

// Resolve the archive.org music provider when enabled. Opt-in via
// $CANARY_ARCHIVE_MUSIC=1 (it reaches out to the network and licensing/quality
// vary, so it's not on by default). Returns just notes when disabled.
export function resolveArchiveMusic(opts: {
  env: NodeJS.ProcessEnv;
  ffmpeg: string;
  log: Logger;
  notes: string[];
  echo?: Echo;
}): Pick<MediaProviders, "music"> & { enabled: boolean } {
  const { env, ffmpeg, log, notes, echo } = opts;
  if (env.CANARY_ARCHIVE_MUSIC !== "1") {
    return { enabled: false };
  }
  log.debug("archive.org music provider enabled");
  return {
    enabled: true,
    music: createMusicProvider({ ffmpeg, echo, log, notes }),
  };
}
