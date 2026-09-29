/**
 * Builds synthetic Claude Code transcripts in the observed JSONL shape (Claude Code 2.1.283).
 * All content is invented; no real transcript data is used.
 */
import { writeFile } from "node:fs/promises";

type Json = Record<string, unknown>;

export class TranscriptBuilder {
  private lines: string[] = [];
  private n = 0;
  private toolN = 0;

  constructor(
    private readonly opts: { sessionId?: string; cwd?: string; version?: string; model?: string; effort?: string } = {},
  ) {}

  private lastUuid: string | null = null;

  private base(type: string, extra: Json): Json {
    this.n++;
    // Chain records like Claude Code does (parentUuid → previous record), so real `claude --resume` can load them.
    const uuid = `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
    const parentUuid = this.lastUuid;
    this.lastUuid = uuid;
    return {
      type,
      uuid,
      parentUuid,
      timestamp: new Date(Date.UTC(2026, 8, 1, 10, 0, this.n)).toISOString(),
      sessionId: this.opts.sessionId ?? "11111111-2222-3333-4444-555555555555",
      cwd: this.opts.cwd ?? "/work/demo-app",
      gitBranch: "main",
      version: this.opts.version ?? "2.1.283",
      isSidechain: false,
      ...extra,
    };
  }

  private push(rec: Json): this {
    this.lines.push(JSON.stringify(rec));
    return this;
  }

  user(text: string, extra: Json = {}): this {
    return this.push(this.base("user", { message: { role: "user", content: text }, ...extra }));
  }

  pasted(authored: string, pasted: string, id = "ab12"): this {
    return this.user(`${authored}\n\n<pasted_content id="${id}">\n${pasted}\n</pasted_content id="${id}">`);
  }

  say(text: string): this {
    return this.push(this.assistant([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }]));
  }

  private assistant(content: Json[]): Json {
    return this.base("assistant", {
      message: { role: "assistant", model: this.opts.model ?? "claude-opus-5-5", content },
      effort: this.opts.effort ?? "medium",
    });
  }

  /** A non-Bash tool call with an ok or error result. */
  tool(name: string, input: Json, result: { error?: string; content?: string } = {}): this {
    const id = `toolu_${++this.toolN}`;
    this.push(this.assistant([{ type: "tool_use", id, name, input }]));
    const isError = result.error !== undefined;
    const content = isError ? `<tool_use_error>${result.error}</tool_use_error>` : (result.content ?? "ok");
    return this.push(
      this.base("user", {
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
        toolUseResult: isError ? `Error: ${result.error}` : { filePath: input.file_path },
      }),
    );
  }

  /** A Bash call. `exit` non-zero produces the observed "Exit code N" error shape. */
  bash(command: string, r: { exit?: number; stdout?: string; stderr?: string; interrupted?: boolean; noResult?: boolean } = {}): this {
    const id = `toolu_${++this.toolN}`;
    this.push(this.assistant([{ type: "tool_use", id, name: "Bash", input: { command, description: "run" } }]));
    if (r.noResult) return this;
    const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (r.exit && r.exit !== 0) {
      const content = `Exit code ${r.exit}\n${out}`;
      return this.push(
        this.base("user", {
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] },
          toolUseResult: `Error: ${content}`,
        }),
      );
    }
    return this.push(
      this.base("user", {
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: r.stdout ?? "", is_error: false }] },
        toolUseResult: { stdout: r.stdout ?? "", stderr: r.stderr ?? "", interrupted: !!r.interrupted },
      }),
    );
  }

  edit(file_path: string, error?: string): this {
    return this.tool("Edit", { file_path, old_string: "a", new_string: "b" }, error ? { error } : {});
  }
  write(file_path: string): this {
    return this.tool("Write", { file_path, content: "x" });
  }
  read(file_path: string): this {
    return this.tool("Read", { file_path }, { content: "file contents" });
  }
  interrupt(): this {
    return this.user("[Request interrupted by user for tool use]");
  }
  compact(): this {
    return this.push(this.base("system", { subtype: "compact_boundary", content: "Conversation compacted" }));
  }
  title(t: string): this {
    return this.push({ type: "ai-title", aiTitle: t, sessionId: this.opts.sessionId ?? "11111111-2222-3333-4444-555555555555" });
  }
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  toString(): string {
    return this.lines.join("\n") + "\n";
  }
  async save(path: string): Promise<string> {
    await writeFile(path, this.toString());
    return path;
  }
}
