import type { Config } from "../config/config.js";
import { DEFAULT_BUDGET } from "./select.js";
import type { SelectionBudget } from "./types.js";

export function budgetFromConfig(config: Config): SelectionBudget {
  const s = config.selection;
  return {
    ...DEFAULT_BUDGET,
    maxTokens: s.max_tokens,
    minScore: s.min_score,
    caps: {
      ...DEFAULT_BUDGET.caps,
      user_prompt: s.max_turns,
      claude_response: s.max_turns,
      attempt: s.max_attempts,
      failure: s.max_failures,
      verification: s.max_verifications,
      project_instruction: s.max_instruction_files,
    },
    groupCaps: DEFAULT_BUDGET.groupCaps.map((g) => (g.name === "files" ? { ...g, max: s.max_files } : g)),
  };
}
