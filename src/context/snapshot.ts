/**
 * ContextSnapshot: what Context Compiler knows about the current Claude Code task, and
 * how certain it is. This is the only input later phases (rank → select → compress →
 * compile) receive; it is also what `ccp context --json` prints.
 *
 * Certainty vocabulary used throughout:
 *   confirmed  — directly recorded by a tool (exit code, tool error, Edit/Write call)
 *   reported   — someone said so in the conversation (user or Claude), not verified
 *   inferred   — derived heuristically (e.g. from shell command text)
 *   uncertain  — a signal exists but its meaning is ambiguous
 */
import type {
  AssistantMessage,
  Excerpt,
  ParseDiagnostics,
  SessionMetadata,
  SubagentInfo,
  ToolCall,
  UserPrompt,
} from "./adapters/types.js";
import type { SessionLocation } from "./claude-session.js";
import type { GitContext } from "./git.js";
import type { InstructionFile } from "./instructions.js";
import type { InferredWrite } from "./analysis/shell.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface ObservedFile {
  path: string;
  via: string;
  lastTurn: number;
}

/** Where a path sits relative to the project root. `unknown` when it can't be resolved (shell expansions). */
export type PathLocation = "inside_project" | "outside_project" | "unknown";

export interface ConfirmedChange {
  path: string;
  location: PathLocation;
  tools: string[];
  turns: number[];
}

export interface InferredChange extends InferredWrite {
  certainty: "inferred";
  location: PathLocation;
  turn: number;
  toolCallId: string;
  command: string;
  /** Set when the command that would have written the file itself failed. */
  commandFailed: boolean;
}

export interface FilesTouched {
  observed: ObservedFile[];
  /** Edit/Write-family tool calls that succeeded. */
  confirmedChanges: ConfirmedChange[];
  /** Files that appear to have been written/deleted by shell commands. Never treat as fact. */
  inferredChanges: InferredChange[];
  /** Commands that may have changed files in ways the transcript can't establish (inline scripts). */
  unknownEffects: { toolCallId: string; turn: number; command: string; reason: string }[];
}

/**
 * completed / failed: a result was recorded.
 * running:   no result yet, the session is live and busy, and nothing happened after it.
 * abandoned: interrupted, or the conversation moved on to a new user turn without a result.
 * unknown:   no result and the transcript doesn't establish why.
 */
export type ToolCallState = "completed" | "failed" | "running" | "abandoned" | "unknown";
export type TrackedToolCall = ToolCall & { state: ToolCallState };

export type FailureKind =
  | "tool_error"
  | "nonzero_exit"
  | "test_failure"
  | "interrupted"
  | "user_reported"
  | "assistant_reported"
  | "possible_failure";

export interface FailureSignal {
  id: string;
  kind: FailureKind;
  certainty: "confirmed" | "reported" | "uncertain";
  turn: number;
  timestamp: string | null;
  source:
    | { type: "tool_call"; toolCallId: string; tool: string; command?: string; exitCode: number | null }
    | { type: "user_prompt" }
    | { type: "assistant_message" };
  /** Verbatim excerpt that supports the signal. */
  evidence: string;
  note?: string;
}

export type AttemptOutcome =
  | "reported_failure"
  | "confirmed_failure"
  | "claimed_problem"
  | "verified_success"
  | "unverified";

export interface Attempt {
  turn: number;
  /** The user's own words that started this turn; if they only pasted, "[pasted] " + the pasted text (untrusted). */
  request: string;
  startedAt: string | null;
  changes: { confirmed: string[]; inferred: string[] };
  commands: { command: string; status: string; exitCode: number | null; verification: boolean }[];
  /** Last verification command run after the last change in this turn, if any. */
  verification: { command: string; status: string; exitCode: number | null } | null;
  /** Claude's last message in the turn. Claude's own claim, not verified. */
  claudeSaid: string | null;
  outcome: AttemptOutcome;
  evidence: { signalId: string; kind: FailureKind; certainty: FailureSignal["certainty"]; detail: string }[];
}

export interface SessionTaskContext {
  /** Most recent prompt the user sent Claude Code. */
  lastUserPrompt: UserPrompt | null;
  recentPrompts: UserPrompt[];
  recentResponses: AssistantMessage[];
  toolCalls: TrackedToolCall[];
  commands: { command: string; turn: number; state: ToolCallState; exitCode: number | null; verification: boolean }[];
  toolCallStates: Record<ToolCallState, number>;
  interruptions: number;
}

export type SessionContext =
  | {
      status: "loaded";
      detection: SessionLocation;
      metadata: SessionMetadata;
      diagnostics: ParseDiagnostics;
      window: { turns: number; fromTurn: number; toTurn: number };
      task: SessionTaskContext;
      files: FilesTouched;
      failures: FailureSignal[];
      attempts: Attempt[];
      compactions: { turn: number; timestamp: string | null }[];
      subagents: SubagentInfo[];
      unknowns: string[];
    }
  | { status: "none" | "unreadable" | "incompatible"; detection: SessionLocation; error: string | null };

export interface ContextLimits {
  maxSessionTurns: number;
  maxPromptChars: number;
  maxResponseChars: number;
  maxToolOutputChars: number;
  maxDiffBytes: number;
  maxInstructionFileBytes: number;
  maxListedFiles: number;
}

export interface ContextSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  cwd: string;
  /** The instruction passed to ccp, when there is one. */
  request: string | null;
  project: { root: string; name: string; packageManager: string | null };
  git: GitContext;
  instructions: InstructionFile[];
  claudeCode: { installedVersion: string | null };
  session: SessionContext;
  limits: ContextLimits;
  /** Rough token estimates per section, for Phase 4 budgeting. */
  sizes: Record<string, number>;
  /** Every file the context layer opened while building this snapshot. */
  provenance: { filesRead: string[] };
  warnings: string[];
}

export type { Excerpt };
