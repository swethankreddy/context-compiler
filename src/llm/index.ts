import type { Config } from "../config/config.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { ProviderError, type LLMProvider } from "./provider.js";

export function createProvider(config: Config, env: NodeJS.ProcessEnv = process.env): LLMProvider {
  switch (config.provider) {
    case "claude-cli":
      return new ClaudeCliProvider({ bin: env.CCP_CLAUDE_BIN, env });
    case "anthropic":
      throw new ProviderError("the Anthropic API provider is not implemented yet; use provider: claude-cli");
  }
}
