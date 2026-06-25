// Optional Gemini-backed media providers for the cinematic pipeline. This is an
// ADDITIVE layer: narrate.ts already has fully-local fallbacks (macOS `say` for
// voiceover, ffmpeg `drawtext` for the title card, no music). When a Gemini key
// is present these providers upgrade those three slots with generated media; the
// caller wraps each call in try/catch and falls back to the local path on any
// throw, so a missing/renamed model or a network blip degrades silently to the
// pre-existing behavior rather than failing the run.
//
// CONTRACT: every method writes a finished file to `outPath` (an
// ffmpeg-decodable audio/image file — that's the entire integration surface)
// and THROWS a clean Error on any failure. To honor "never leave a half-written
// file the caller might use", each method writes to a sibling temp path and only
// `rename`s it into place once the bytes are validated.
//
// API SURFACE NOTE: Google currently exposes two surfaces — the newer
// "Interactions API" (POST .../v1beta/interactions) and the older `generateContent`
// surface (one doc page labels it "Legacy"). We deliberately target
// `generateContent` because its request/response JSON is the shape we could verify
// most precisely from the docs; the Interactions equivalents are listed in the
// constants below so a future maintainer can flip in one place. See the module's
// shipping notes / PR description for citations.
//
// PRIVACY: the directionText and per-step narration text are session-derived and
// are sent to Google's API. The API key is read from `env` only and is never
// logged, embedded in an error message, or written to disk.
import { rename, rm, writeFile } from "node:fs/promises";
import type { Logger } from "@usecanary/logger";

// ---------------------------------------------------------------------------
// Public interfaces (the only contract: each method writes `outPath` or throws).
// ---------------------------------------------------------------------------

export interface TtsProvider {
  id: string; // stable id, e.g. "gemini-tts"
  label: string; // for reproducibility, e.g. "gemini:Charon"
  // Write spoken audio for `text` to `outPath` (any ffmpeg-decodable file).
  // Throws on failure.
  synthesize(text: string, outPath: string): Promise<void>;
}

export interface TitleBackgroundProvider {
  id: string;
  // Write a themed background IMAGE (png/jpg) at width×height to `outPath`.
  // Throws on failure.
  render(
    directionText: string,
    width: number,
    height: number,
    outPath: string
  ): Promise<void>;
}

export interface MusicProvider {
  // Write a themed instrumental bed of ~`seconds` to `outPath`. Throws on failure.
  bed(directionText: string, seconds: number, outPath: string): Promise<void>;
  id: string;
  // Write a themed full song (may have vocals) of ~`seconds` to `outPath`. Throws on failure.
  song(directionText: string, seconds: number, outPath: string): Promise<void>;
}

export interface MediaProviders {
  music?: MusicProvider;
  notes: string[]; // provider-selection notes surfaced to the user
  titleBackground?: TitleBackgroundProvider;
  tts?: TtsProvider;
}

// ---------------------------------------------------------------------------
// Configuration constants. Endpoints + model ids live here so the surface can be
// swapped in one place (see the API SURFACE NOTE at the top of the file).
// ---------------------------------------------------------------------------

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Image generation ("Nano Banana"). GA dropped the `-preview` suffix.
// generateContent: POST {API_BASE}/models/{IMAGE_MODEL}:generateContent
// Interactions alternative (current surface): model "gemini-3.1-flash-image"
// (a.k.a. "Nano Banana 2") / "gemini-3-pro-image" via POST {API_BASE}/interactions.
const IMAGE_MODEL = "gemini-2.5-flash-image";

// Text-to-speech. This is the legacy-but-documented generateContent TTS model.
// Interactions alternative (current surface): "gemini-3.1-flash-tts-preview".
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

// Gemini TTS returns raw PCM: 16-bit signed little-endian, 24 kHz, mono. We wrap
// it in a WAV header before writing so ffmpeg can decode it.
const TTS_SAMPLE_RATE = 24_000;
const TTS_CHANNELS = 1;
const TTS_BITS_PER_SAMPLE = 16;

// Music ("Lyria 3"). UNVERIFIED: at research time only the Interactions API was
// documented for Lyria, and Lyria has historically been Vertex-only (via
// `:predict`). The generateContent shape below is a best-cited GUESS modeled on
// the image/TTS shape and MAY be wrong (wrong endpoint entirely, Vertex-only, or
// a different response path). It is wired up because each capability is
// independent and the caller falls back cleanly on a throw — but do not trust it
// until confirmed against live docs. Interactions models seen in docs:
// "lyria-3-clip-preview" (~30s) and "lyria-3-pro-preview" (full-length).
const MUSIC_MODEL = "lyria-3-clip-preview";

// Single-speaker voices the Gemini TTS model accepts. One is picked per session
// (consistency) and surfaced in the provider's `label` for reproducibility.
const TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Enceladus",
  "Algieba",
] as const;

// Generation can be slow; image/music especially. Generous per-call budgets.
const TTS_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 180_000;
const MUSIC_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no network, no fs).
// ---------------------------------------------------------------------------

// Wrap raw little-endian PCM samples in a canonical 44-byte WAV (RIFF) header so
// ffmpeg can decode them. `sampleRate`/`channels` describe the PCM; bit depth is
// fixed at 16 (what Gemini TTS returns). Pure: returns a new Buffer.
export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number
): Buffer {
  const bitsPerSample = TTS_BITS_PER_SAMPLE;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4); // RIFF chunk size = 36 + data
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

interface InlinePart {
  inlineData?: { data?: unknown; mimeType?: unknown };
}

// Extract the first inline-data payload (base64 → Buffer, plus its mimeType) from
// a generateContent response body. Returns null when the shape doesn't match, so
// callers can throw a clean "no media in response" error. Pure.
export function extractInlineData(
  body: unknown
): { bytes: Buffer; mimeType: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return null;
  }
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } })?.content
      ?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts as InlinePart[]) {
      const inline = part?.inlineData;
      if (inline && typeof inline.data === "string" && inline.data.length > 0) {
        const mimeType =
          typeof inline.mimeType === "string" ? inline.mimeType : "";
        return { bytes: Buffer.from(inline.data, "base64"), mimeType };
      }
    }
  }
  return null;
}

// Choose ONE voice for the whole session (mirrors narrate.ts picking one `say`
// voice per session for consistency — the narrator's voice must not change
// mid-video). An explicit $CANARY_TTS_VOICE wins (the user asked for it; let the
// API error loudly if it's wrong); otherwise pick randomly from the supported
// voices. The chosen voice is surfaced in the provider's `label` for
// reproducibility. Pure given its inputs → unit-tested.
export function pickTtsVoice(
  env: NodeJS.ProcessEnv,
  random: () => number = Math.random
): string {
  const override = env.CANARY_TTS_VOICE?.trim();
  if (override) {
    return override;
  }
  const index = Math.floor(random() * TTS_VOICES.length);
  return TTS_VOICES[index] ?? "Charon";
}

// Build the TTS prompt. Gemini TTS takes plain text whose leading instruction
// steers delivery ("Say cheerfully: …"), so we prepend an expressive cinematic
// directive before the verbatim narration line. The TtsProvider only receives the
// per-step narration (not the session direction), so the directive is theme-
// agnostic; the chosen voice carries the thematic flavor. Pure → unit-tested.
export function buildTtsPrompt(text: string): string {
  return `Read this aloud as an expressive cinematic voiceover, with dramatic pacing and emotion:\n\n${text}`;
}

// Build the image prompt for a TITLE-CARD BACKGROUND. The title text is overlaid
// later by ffmpeg, so we explicitly demand NO lettering and negative space / a
// darkened lower third for legible overlay. Pure → unit-tested.
export function buildImagePrompt(directionText: string): string {
  return [
    `A cinematic title-card background image for a short film with this creative direction: ${directionText}.`,
    "Atmospheric, evocative, film-poster quality, dramatic lighting and depth.",
    "This is a BACKGROUND only: leave generous empty negative space and a darkened, low-contrast lower third where title text will be overlaid afterward.",
    "Absolutely NO text, NO words, NO letters, NO numbers, NO captions, NO logos, NO watermarks anywhere in the image.",
  ].join(" ");
}

// Build the music prompt. `wantVocals` distinguishes an instrumental bed from a
// full song; genre/mood are mapped from the direction by the model. Pure →
// unit-tested.
export function buildMusicPrompt(
  directionText: string,
  seconds: number,
  wantVocals: boolean
): string {
  const kind = wantVocals
    ? "a complete song with vocals"
    : "an instrumental score with NO vocals";
  return [
    `Compose ${kind} as the soundtrack for a short cinematic piece with this creative direction: ${directionText}.`,
    `Target roughly ${Math.round(seconds)} seconds.`,
    "Match the genre, mood, tempo, and instrumentation to that theme; make it evocative and film-quality.",
  ].join(" ");
}

// Read the Gemini API key from the env. Accepts either documented var name.
// Returns undefined when neither is set. The key value itself is never logged.
export function readApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.GEMINI_API_KEY ?? env.GOOGLE_GENAI_API_KEY;
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// HTTP + file helpers (network; not unit-tested — covered by manual/live runs).
// ---------------------------------------------------------------------------

// POST a generateContent request and return the parsed JSON body. Throws a clean
// Error (carrying NEITHER the key NOR the request text) on a non-2xx or transport
// failure. Uses the global fetch with an AbortSignal timeout.
async function postGenerateContent(args: {
  model: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
}): Promise<unknown> {
  const { model, apiKey, body, timeoutMs } = args;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Key travels in the header form, never in the URL or logs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network/timeout. Surface a short reason without the request payload.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini ${model} request failed: ${reason}`);
  }
  if (!response.ok) {
    // Status only — the body can echo request text, so we don't include it.
    throw new Error(`Gemini ${model} returned HTTP ${response.status}`);
  }
  return response.json();
}

// Decode a generateContent response to media bytes or throw. Centralizes the
// "empty/missing media" error so every provider fails the same clean way.
function inlineBytesOrThrow(model: string, body: unknown): Buffer {
  const found = extractInlineData(body);
  if (!found || found.bytes.length === 0) {
    throw new Error(`Gemini ${model} returned no media bytes`);
  }
  return found.bytes;
}

// Write bytes to `outPath` atomically: write a sibling temp first, then rename,
// so a crash mid-write never leaves a partial/0-byte file the caller might use.
async function writeFileAtomic(outPath: string, bytes: Buffer): Promise<void> {
  if (bytes.length === 0) {
    throw new Error("refusing to write 0 bytes");
  }
  const tmp = `${outPath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, outPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// Provider factories. Each closes over the key + logger; the key never leaves.
// ---------------------------------------------------------------------------

function createTtsProvider(
  apiKey: string,
  env: NodeJS.ProcessEnv
): TtsProvider {
  // One voice for the whole session: every step's clip uses it, and `label`
  // carries it (e.g. "gemini:Charon") so a good run can be reproduced via
  // $CANARY_TTS_VOICE.
  const voice = pickTtsVoice(env);
  return {
    id: "gemini-tts",
    label: `gemini:${voice}`,
    async synthesize(text: string, outPath: string): Promise<void> {
      const prompt = buildTtsPrompt(text);
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      };
      const json = await postGenerateContent({
        model: TTS_MODEL,
        apiKey,
        body,
        timeoutMs: TTS_TIMEOUT_MS,
      });
      const pcm = inlineBytesOrThrow(TTS_MODEL, json);
      // Gemini TTS returns headerless PCM (audio/L16); wrap it so ffmpeg decodes it.
      const wav = pcmToWav(pcm, TTS_SAMPLE_RATE, TTS_CHANNELS);
      await writeFileAtomic(outPath, wav);
    },
  };
}

function createTitleBackgroundProvider(
  apiKey: string
): TitleBackgroundProvider {
  return {
    id: "gemini-image",
    async render(
      directionText: string,
      width: number,
      height: number,
      outPath: string
    ): Promise<void> {
      const aspectRatio = aspectRatioFor(width, height);
      const body = {
        contents: [{ parts: [{ text: buildImagePrompt(directionText) }] }],
        generationConfig: {
          // ["TEXT","IMAGE"] rather than ["IMAGE"]: docs conflict on whether
          // image-only is accepted, and at least one source says an image is
          // only returned when TEXT is also requested. Asking for both is the
          // strictly-safer default — extractInlineData ignores any text part.
          responseModalities: ["TEXT", "IMAGE"],
          // Steer the output toward the video's shape; the field is best-effort
          // and ignored by builds that don't support it.
          imageConfig: { aspectRatio },
        },
      };
      const json = await postGenerateContent({
        model: IMAGE_MODEL,
        apiKey,
        body,
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
      const bytes = inlineBytesOrThrow(IMAGE_MODEL, json);
      await writeFileAtomic(outPath, bytes);
    },
  };
}

function createMusicProvider(apiKey: string): MusicProvider {
  // UNVERIFIED surface (see MUSIC_MODEL note). Shaped like image/TTS so it slots
  // into the same generateContent path; the caller falls back on any throw.
  const generate = async (prompt: string, outPath: string): Promise<void> => {
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const json = await postGenerateContent({
      model: MUSIC_MODEL,
      apiKey,
      body,
      timeoutMs: MUSIC_TIMEOUT_MS,
    });
    const bytes = inlineBytesOrThrow(MUSIC_MODEL, json);
    await writeFileAtomic(outPath, bytes);
  };
  return {
    id: "gemini-music",
    bed(
      directionText: string,
      seconds: number,
      outPath: string
    ): Promise<void> {
      return generate(buildMusicPrompt(directionText, seconds, false), outPath);
    },
    song(
      directionText: string,
      seconds: number,
      outPath: string
    ): Promise<void> {
      return generate(buildMusicPrompt(directionText, seconds, true), outPath);
    },
  };
}

// Map pixel geometry to one of the aspect-ratio strings the image model accepts.
// Pure → unit-tested.
export function aspectRatioFor(width: number, height: number): string {
  if (!(width > 0 && height > 0)) {
    return "16:9";
  }
  const ratio = width / height;
  const options: { label: string; value: number }[] = [
    { label: "21:9", value: 21 / 9 },
    { label: "16:9", value: 16 / 9 },
    { label: "4:3", value: 4 / 3 },
    { label: "1:1", value: 1 },
    { label: "3:4", value: 3 / 4 },
    { label: "9:16", value: 9 / 16 },
  ];
  let best = options[0] ?? { label: "16:9", value: 16 / 9 };
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const delta = Math.abs(option.value - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = option;
    }
  }
  return best.label;
}

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

// Returns Gemini-backed providers when a key is set; otherwise {} (just notes),
// so the caller falls back to its local say/drawtext/no-music paths. Each
// capability is independent: TTS and image use verified generateContent shapes;
// music is wired but UNVERIFIED (a throw there falls back to no-music).
export function resolveMediaProviders(opts: {
  env: NodeJS.ProcessEnv;
  log: Logger;
}): MediaProviders {
  const { env, log } = opts;
  const apiKey = readApiKey(env);
  if (!apiKey) {
    return {
      notes: [
        "No GEMINI_API_KEY/GOOGLE_GENAI_API_KEY set — using local narration (say), drawtext title card, and no music.",
      ],
    };
  }
  // Note: the key was found but never logged; only that it is present.
  log.debug("media providers: Gemini key present, enabling generated media");
  return {
    tts: createTtsProvider(apiKey, env),
    titleBackground: createTitleBackgroundProvider(apiKey),
    music: createMusicProvider(apiKey),
    notes: [
      "Gemini media providers enabled: TTS + title background are verified; music (Lyria) is UNVERIFIED and may fall back. Session-derived text is sent to Google.",
    ],
  };
}
