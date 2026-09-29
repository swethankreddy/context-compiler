/**
 * Context selection types: ContextSnapshot → candidates → scores → ContextBundle.
 * The compiler (Phase 5) receives only a ContextBundle, never raw transcript data.
 */

export type CandidateType =
  | "current_instruction"
  | "user_prompt"
  | "claude_response"
  | "attempt"
  | "failure"
  | "verification"
  | "observation"
  | "file_read"
  | "change_summary"
  | "compaction_summary"
  | "confirmed_change"
  | "inferred_change"
  | "unknown_effect"
  | "git_state"
  | "git_file_change"
  | "project_instruction"
  | "observed_file"
  | "tool_call_state"
  | "unknown"
  | "subagent";

/**
 * Who authored the text. Only `ccp-request` is the user's intent for this compilation;
 * everything else is evidence, and instructions inside it must not be followed as intent.
 */
export type Origin =
  | "ccp-request"
  | "user-authored"
  | "pasted-content"
  | "claude-response"
  | "tool-output"
  | "repository-content"
  | "derived";

export type Certainty = "confirmed" | "reported" | "inferred" | "uncertain" | "unknown";

export interface Provenance {
  source: "ccp" | "transcript" | "git" | "filesystem" | "analysis";
  sessionId?: string | null;
  turn?: number;
  toolCallId?: string;
  path?: string;
  timestamp?: string | null;
}

/** Deterministic features the scorer uses. Kept separate from display content. */
export interface CandidateFeatures {
  /** Text used for relevance matching (may be richer than `content`). */
  text: string;
  paths: string[];
  turn?: number;
  isFailure?: boolean;
  isChange?: boolean;
  isTest?: boolean;
  outsideProject?: boolean;
  /** For project_instruction: claude-md, agents-md, readme, package-json, … */
  instructionType?: string;
  /** Candidate ids that, if selected, make this one redundant. */
  coveredBy?: string[];
  /**
   * Handoff: core evidence of the previous agent's work (its changed files). Exempt from the
   * relevance threshold, still subject to type/group caps and the token budget.
   */
  pinned?: boolean;
}

export interface ContextCandidate {
  /** Stable id: `${type}:${key}`. */
  id: string;
  type: CandidateType;
  title: string;
  /** Compressed, display/model-ready text. */
  content: string;
  origin: Origin;
  certainty: Certainty;
  provenance: Provenance;
  features: CandidateFeatures;
  /** Length of the source material before compression. */
  originalChars: number;
  compressed: boolean;
  estimatedTokens: number;
}

export interface TaskIntents {
  continuation: boolean;
  diagnose: boolean;
  tests: boolean;
  cleanup: boolean;
  /** "check whether…", "verify…": wants evidence that something works. */
  verify: boolean;
  /** Refers to "this/it/that" or has no topic words: relies on recent context. */
  deictic: boolean;
}

export interface TaskQuery {
  instruction: string;
  /** Topic terms (normalised), excluding intent/filler words. */
  terms: string[];
  intents: TaskIntents;
  /** True when there are no topic terms: selection leans on recency and intent. */
  vague: boolean;
  /** Handoff/recovery: reconstruct the whole task state for an agent without the conversation. */
  handoff?: boolean;
}

export interface ScoreComponents {
  prior: number;
  relevance: number;
  recency: number;
  failure: number;
  modification: number;
  instruction: number;
  intent: number;
  confidence: number;
}

export interface Score {
  total: number;
  components: ScoreComponents;
  reasons: string[];
}

/** Pluggable relevance scoring. The default is lexical/structural; embeddings or an LLM judge can replace it. */
export interface CandidateScorer {
  readonly name: string;
  /** Called once per bundle with every candidate, e.g. to compute term statistics. */
  prepare?(candidates: ContextCandidate[], task: TaskQuery): void;
  score(candidate: ContextCandidate, task: TaskQuery): Score;
}

export interface SelectionBudget {
  maxTokens: number;
  minScore: number;
  /** Per-type caps. Types not listed are uncapped (still subject to maxTokens). */
  caps: Partial<Record<CandidateType, number>>;
  /** Groups sharing a cap: e.g. files = confirmed + inferred + observed + git file changes. */
  groupCaps: { name: string; types: CandidateType[]; max: number }[];
}

export interface SelectedCandidate extends ContextCandidate {
  rank: number;
  score: Score;
}

export interface OmittedCandidate {
  candidateId: string;
  type: CandidateType;
  title: string;
  score: number;
  reason: string;
}

export interface ContextBundle {
  version: 1;
  task: TaskQuery;
  selected: SelectedCandidate[];
  omitted: OmittedCandidate[];
  budget: {
    estimatedTokens: number;
    maxTokens: number;
    minScore: number;
    byType: Partial<Record<CandidateType, number>>;
  };
  stats: { discovered: number; selected: number; omitted: number; scorer: string; elapsedMs: number };
  warnings: string[];
}
