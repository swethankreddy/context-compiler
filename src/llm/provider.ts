import type { Effort } from "../config/config.js";

/**
 * Model backend. The compiler depends only on this interface; implementations:
 * ClaudeCliProvider (`claude -p`, default) and, later, an Anthropic API provider.
 */
export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRequest {
  system: string;
  user: string;
  model: string;
  effort: Effort;
  /** JSON Schema the response must satisfy, when the backend supports structured output. */
  jsonSchema?: object;
  timeoutMs?: number;
}

export interface LLMResponse {
  /** Raw text of the final answer. */
  text: string;
  /** Parsed structured output when the backend validated it against `jsonSchema`. */
  structured?: unknown;
  model: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  costUsd?: number;
}

export class ProviderError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "ProviderError";
  }
}
