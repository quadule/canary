// Provider-neutral text generation for Dailies.
//
// Everything that needs an LLM — narration, song lyrics, and the nightly demo
// decision — asks for ONE thing: an object matching a JSON schema. That is the
// whole contract, so a backend qualifies if it can be talked into returning
// schema-shaped JSON.
//
// Three backends ship (see ./providers):
//
//   claude   the `claude` CLI. The default, because it needs no API key and no
//            local model — if you have Claude Code, it already works.
//   openai   any OpenAI-compatible /v1/chat/completions endpoint: OpenAI,
//            OpenRouter, LM Studio, Ollama, vLLM, llama.cpp — and any local
//            bridge that speaks that shape.
//   apple    Apple Intelligence's on-device Foundation Models, via a small
//            Swift helper. No key, no network, nothing leaves the machine.
//
// The Anthropic Messages API is deliberately NOT a fourth provider here: the
// `claude` CLI already covers Claude, and this package ships no runtime
// dependencies. An SDK-backed provider would slot in behind this same interface.

import type { Logger } from "dailies-logger";

// Echoes the command/request a provider is about to make, so a run is
// reproducible. Never receives a secret: keys are echoed as `$VAR` references.
export type Echo = (line: string) => void;

export interface GenerateJsonArgs {
  echo?: Echo;
  // Names the generation in logs and echoes ("narration", "lyrics", …).
  label: string;
  log: Logger;
  prompt: string;
  // A JSON Schema object describing the required reply shape.
  schema: unknown;
  timeoutMs: number;
}

export interface TextProvider {
  // How this backend would appear in run notes, e.g. "Apple Intelligence
  // (on-device)". Cheap and side-effect free.
  describe(): string;
  // Produce the raw reply text for `args`. THROWS on transport or availability
  // failure so the caller can fall through to the next provider; a reply that
  // merely fails to parse is returned as text and handled upstream.
  generateJson(args: GenerateJsonArgs): Promise<string>;
  id: ProviderId;
  // Whether this backend can actually run right now — binary on PATH, endpoint
  // configured, model downloaded. Must not throw.
  isAvailable(): Promise<boolean>;
  // The concrete model this provider will use, for the log. "claude" alone
  // doesn't tell you what actually ran; `sonnet` or `gpt-4o-mini` does.
  model: string;
}

export const PROVIDER_IDS = ["claude", "openai", "apple"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
