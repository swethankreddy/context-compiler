/**
 * Format-neutral view of a coding-agent session. Everything outside `adapters/`
 * depends only on these types, never on a transcript file format.
 *
 * Adapters normalise; they do not interpret. Deciding what counts as a failure, an
 * attempt or an inferred change happens in `context/analysis/`.
 */

/** A bounded piece of text. `truncated` means `text` is shorter than the original. */
export interface Excerpt {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export interface PromptSegment {
  /** `authored`: typed by the user. `pasted`: inside <pasted_content> tags, may carry instructions the user did not write. */
  kind: "authored" | "pasted";
  text: string;
}

export interface UserPrompt {
  /** 1-based turn number within the whole session. */
  turn: number;
  timestamp: string | null;
  text: Excerpt;
  segments: PromptSegment[];
  hasPastedContent: boolean;
}

export interface AssistantMessage {
  turn: number;
  timestamp: string | null;
  text: Excerpt;
}

export interface ToolResult {
  status: "ok" | "error" | "interrupted";
  /** Exit code when the transcript states one (Bash non-zero exits); null otherwise. */
  exitCode: number | null;
  /** Error text for failed results. */
  errorText: Excerpt | null;
  /** Tail of the output for successful commands (Bash only). */
  outputTail: Excerpt | null;
  /** Content of a file Claude read (Read tool), as Claude saw it. */
  fileContent?: Excerpt;
}

export interface ToolCall {
  id: string;
  turn: number;
  timestamp: string | null;
  tool: string;
  /** Short, display-safe summary of the input. */
  summary: string;
  filePath?: string;
  command?: string;
  /** null while no result has been recorded (still running, or the session was cut off). */
  result: ToolResult | null;
}

export interface Interruption {
  turn: number;
  timestamp: string | null;
}

export interface Compaction {
  turn: number;
  timestamp: string | null;
  /** The summary Claude Code wrote at compaction (what the agent still "remembers"), when recorded. */
  summary?: Excerpt;
}

export interface SubagentInfo {
  agentType: string | null;
  description: string | null;
  model: string | null;
}

export interface SessionMetadata {
  sessionId: string | null;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  /** Claude Code versions that wrote the records we parsed. */
  claudeCodeVersions: string[];
  /** Most recent model / effort seen, plus all distinct values. */
  currentModel: string | null;
  currentEffort: string | null;
  models: string[];
  efforts: string[];
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  turnCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  compactionCount: number;
}

export interface ParseDiagnostics {
  adapter: string;
  adapterFormatVersion: string;
  status: "ok" | "partial" | "incompatible";
  totalLines: number;
  parsedLines: number;
  malformedLines: number;
  unknownRecordTypes: string[];
  notes: string[];
}

/** The whole session, normalised. Text is already bounded by `ReadOptions`. */
export interface SessionSnapshot {
  transcriptPath: string;
  metadata: SessionMetadata;
  prompts: UserPrompt[];
  responses: AssistantMessage[];
  toolCalls: ToolCall[];
  interruptions: Interruption[];
  compactions: Compaction[];
  subagents: SubagentInfo[];
  diagnostics: ParseDiagnostics;
}

export interface ReadOptions {
  maxPromptChars: number;
  maxResponseChars: number;
  maxToolOutputChars: number;
  /** Handoff/recovery: also keep what Grep/Glob returned (normal mode keeps shell output only). */
  captureSearchOutput?: boolean;
}

export interface SessionAdapter {
  readonly name: string;
  read(transcriptPath: string, opts: ReadOptions): Promise<SessionSnapshot>;
}
