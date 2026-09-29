/**
 * Adapter for Claude Code's local transcript files
 * (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl).
 *
 * This format is UNDOCUMENTED. It was reverse-engineered from transcripts written by
 * Claude Code 2.1.282–2.1.283. All knowledge of it lives in this file so it can be
 * replaced when Claude Code changes the format or ships a supported API.
 *
 * Observed conventions this adapter relies on:
 * - A human prompt is a `user` record whose content is text; tool results are `user`
 *   records whose content holds `tool_result` blocks.
 * - A Bash command that exits non-zero yields `is_error: true` and content starting
 *   with "Exit code N".
 * - "[Request interrupted by user…]" arrives as a user text record.
 * - `system` records with subtype `compact_boundary` mark context compaction. The records before
 *   it stay in the file (verified on 2.1.283); the agent's context keeps only a summary, stored as
 *   a `user` record with `isCompactSummary: true`. That summary is Claude-generated, not the user's.
 *
 * Thinking blocks (including progress-update thinking blocks) are never read: the
 * model's internal reasoning is not a source of task context.
 *
 * The adapter never throws on unexpected content: unknown record types are counted,
 * malformed lines are skipped, and a file with no recognisable records is reported as
 * `incompatible` instead of failing the CLI.
 */
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { errorExcerpt, excerpt } from "../excerpt.js";
import type {
  ParseDiagnostics,
  PromptSegment,
  ReadOptions,
  SessionAdapter,
  SessionMetadata,
  SessionSnapshot,
  SubagentInfo,
  ToolCall,
  ToolResult,
} from "./types.js";

export const FORMAT_VERSION = "claude-code-jsonl/2";
export const VERIFIED_CLAUDE_CODE_VERSIONS = ["2.1.282", "2.1.283"];

/** Record types seen in real transcripts that we deliberately ignore. */
const IGNORED_TYPES = new Set([
  "attachment", "last-prompt", "mode", "permission-mode", "atis-latch", "file-history-snapshot",
  "file-history-delta", "bridge-session", "pr-link", "agent-name", "worktree-state", "agent-setting",
  "queue-operation", "relocated", "frame-link", "cost-state", "artifact-autoreact-ledger",
  "agent-color", "artifact-comment-monitor", "history-suppression", "continued-in", "summary",
]);
const HANDLED_TYPES = new Set(["user", "assistant", "system", "ai-title"]);

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Json => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

const PASTED_RE = /<pasted_content id="([^"]+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

/** Splits a prompt into the user's own words and pasted blocks. */
export function splitPasted(text: string, max: number): PromptSegment[] {
  const out: PromptSegment[] = [];
  let last = 0;
  const push = (kind: PromptSegment["kind"], t: string) => {
    if (t.trim()) out.push({ kind, text: excerpt(t.trim(), max).text });
  };
  for (const m of text.matchAll(PASTED_RE)) {
    push("authored", text.slice(last, m.index));
    push("pasted", m[2] ?? "");
    last = m.index! + m[0].length;
  }
  push("authored", text.slice(last));
  return out;
}

function summarizeToolInput(tool: string, input: Json): Pick<ToolCall, "summary" | "filePath" | "command"> {
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? undefined;
  const command = tool === "Bash" ? (str(input.command) ?? undefined) : undefined;
  const summary =
    command ?? filePath ?? str(input.pattern) ?? str(input.url) ?? str(input.query) ?? str(input.description) ?? str(input.prompt) ?? "";
  return { summary: excerpt(summary.replace(/\s+/g, " "), 200).text, filePath, command };
}

/** Read results come back with "N\t" line-number prefixes; strip them when every line has one. */
function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  return lines.every((l) => /^\s*\d+\t/.test(l) || l === "") ? lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n") : text;
}

const MAX_FILE_READ_CHARS = 12_000;

function toolResult(block: Json, tur: unknown, isBash: boolean, opts: ReadOptions, isRead = false, isSearch = false): ToolResult {
  const content = blockText(block.content).replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, "$1");
  const interrupted = isObj(tur) && tur.interrupted === true;
  if (block.is_error === true) {
    const code = content.match(/^Exit code (\d+)/);
    return {
      status: interrupted ? "interrupted" : "error",
      exitCode: code ? Number(code[1]) : null,
      errorText: errorExcerpt(content, opts.maxToolOutputChars),
      outputTail: null,
    };
  }
  if (interrupted) {
    return { status: "interrupted", exitCode: null, errorText: excerpt(str((tur as Json).stderr) ?? "", opts.maxToolOutputChars, "ends"), outputTail: null };
  }
  const stdout = isObj(tur) ? str(tur.stdout) : null;
  const fileText = isRead ? ((isObj(tur) && isObj(tur.file) ? str(tur.file.content) : null) ?? stripLineNumbers(content)) : null;
  return {
    status: "ok",
    exitCode: null,
    errorText: null,
    outputTail: isBash ? excerpt(stdout ?? content, opts.maxToolOutputChars, "tail") : isSearch && opts.captureSearchOutput ? excerpt(content, opts.maxToolOutputChars, "head") : null,
    ...(fileText ? { fileContent: excerpt(fileText, MAX_FILE_READ_CHARS, "head") } : {}),
  };
}

export class ClaudeCodeJsonlAdapter implements SessionAdapter {
  readonly name = "claude-code-jsonl";

  async read(transcriptPath: string, opts: ReadOptions): Promise<SessionSnapshot> {
    const meta: SessionMetadata = {
      sessionId: null, title: null, cwd: null, gitBranch: null, claudeCodeVersions: [], currentModel: null,
      currentEffort: null, models: [], efforts: [], firstTimestamp: null, lastTimestamp: null, turnCount: 0,
      toolCallCount: 0, toolErrorCount: 0, compactionCount: 0,
    };
    const diag: ParseDiagnostics = {
      adapter: this.name, adapterFormatVersion: FORMAT_VERSION, status: "ok", totalLines: 0,
      parsedLines: 0, malformedLines: 0, unknownRecordTypes: [], notes: [],
    };
    const snap: SessionSnapshot = {
      transcriptPath, metadata: meta, prompts: [], responses: [], toolCalls: [], interruptions: [],
      compactions: [], subagents: [], diagnostics: diag,
    };
    const callsById = new Map<string, ToolCall>();
    let turn = 0;
    let conversationRecords = 0;

    const addUnique = (list: string[], v: unknown) => {
      if (typeof v === "string" && v && !list.includes(v)) list.push(v);
    };

    const lines = createInterface({ input: createReadStream(transcriptPath, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      diag.totalLines++;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        diag.malformedLines++;
        continue;
      }
      if (!isObj(rec) || typeof rec.type !== "string") {
        diag.malformedLines++;
        continue;
      }
      diag.parsedLines++;
      const type = rec.type;
      if (!HANDLED_TYPES.has(type)) {
        if (!IGNORED_TYPES.has(type)) addUnique(diag.unknownRecordTypes, type);
        continue;
      }
      // Sidechain records belong to subagents in older formats; subagents are summarised separately.
      if (rec.isSidechain === true) continue;

      const ts = str(rec.timestamp);
      if (ts) {
        meta.firstTimestamp ??= ts;
        meta.lastTimestamp = ts;
      }
      addUnique(meta.claudeCodeVersions, rec.version);
      meta.sessionId ??= str(rec.sessionId);
      meta.cwd = str(rec.cwd) ?? meta.cwd;
      meta.gitBranch = str(rec.gitBranch) ?? meta.gitBranch;

      if (type === "ai-title") {
        meta.title = str(rec.aiTitle) ?? meta.title;
        continue;
      }
      if (type === "system") {
        if (rec.subtype === "compact_boundary") snap.compactions.push({ turn, timestamp: ts });
        continue;
      }

      const msg = rec.message;
      if (!isObj(msg)) continue;
      conversationRecords++;

      if (type === "assistant") {
        const model = str(msg.model);
        const effort = str(rec.effort);
        // "<synthetic>" marks harness-generated messages, not a real model.
        if (model && !model.startsWith("<")) {
          addUnique(meta.models, model);
          meta.currentModel = model;
        }
        if (effort) {
          addUnique(meta.efforts, effort);
          meta.currentEffort = effort;
        }
        if (!Array.isArray(msg.content)) continue;
        for (const b of msg.content) {
          if (!isObj(b)) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            snap.responses.push({ turn, timestamp: ts, text: excerpt(b.text.trim(), opts.maxResponseChars) });
          } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            const call: ToolCall = {
              id: b.id, turn, timestamp: ts, tool: b.name,
              ...summarizeToolInput(b.name, isObj(b.input) ? b.input : {}), result: null,
            };
            callsById.set(b.id, call);
            snap.toolCalls.push(call);
          }
        }
        continue;
      }

      // type === "user": tool results, or a human prompt.
      if (Array.isArray(msg.content) && msg.content.some((b) => isObj(b) && b.type === "tool_result")) {
        for (const b of msg.content) {
          if (!isObj(b) || b.type !== "tool_result") continue;
          const call = callsById.get(str(b.tool_use_id) ?? "");
          if (!call) continue;
          call.result = toolResult(b, rec.toolUseResult, call.tool === "Bash", opts, call.tool === "Read", call.tool === "Grep" || call.tool === "Glob");
        }
        continue;
      }
      if (rec.isCompactSummary === true) {
        const last = snap.compactions.at(-1);
        const summary = excerpt(blockText(msg.content).trim(), opts.maxResponseChars * 4);
        if (last && !last.summary) last.summary = summary;
        else snap.compactions.push({ turn, timestamp: ts, summary });
        continue;
      }
      if (rec.isMeta === true) continue;
      const text = blockText(msg.content).trim();
      if (!text || text.startsWith("<local-command-") || text.startsWith("<command-")) continue;
      if (text.startsWith("[Request interrupted by user")) {
        snap.interruptions.push({ turn, timestamp: ts });
        continue;
      }
      turn++;
      const segments = splitPasted(text, opts.maxPromptChars);
      snap.prompts.push({
        turn, timestamp: ts, text: excerpt(text, opts.maxPromptChars), segments,
        hasPastedContent: segments.some((s) => s.kind === "pasted"),
      });
    }

    snap.subagents = await readSubagents(transcriptPath);
    meta.turnCount = turn;
    meta.toolCallCount = snap.toolCalls.length;
    meta.toolErrorCount = snap.toolCalls.filter((c) => c.result?.status === "error").length;
    meta.compactionCount = snap.compactions.length;

    if (diag.totalLines > 0 && conversationRecords === 0) {
      diag.status = "incompatible";
      diag.notes.push("No user/assistant records with a `message` object were found; the transcript format may have changed.");
    } else if (diag.malformedLines > 0) {
      diag.status = "partial";
      diag.notes.push(`${diag.malformedLines} line(s) could not be parsed and were skipped.`);
    }
    const unverified = meta.claudeCodeVersions.filter((v) => !VERIFIED_CLAUDE_CODE_VERSIONS.includes(v));
    if (unverified.length) {
      diag.notes.push(`Written by Claude Code ${unverified.join(", ")}; adapter verified only on ${VERIFIED_CLAUDE_CODE_VERSIONS.join(", ")}.`);
    }
    return snap;
  }
}

/** Reads subagent metadata only (type, description, model), never their transcripts. */
async function readSubagents(transcriptPath: string): Promise<SubagentInfo[]> {
  const dir = join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentInfo[] = [];
  for (const name of names.filter((n) => n.endsWith(".meta.json") && !n.startsWith("._"))) {
    try {
      const m = JSON.parse(await readFile(join(dir, name), "utf8")) as Json;
      out.push({ agentType: str(m.agentType), description: str(m.description), model: str(m.model) });
    } catch {
      // Unreadable subagent metadata is not worth failing over.
    }
  }
  return out;
}
