/**
 * Builds synthetic Claude Code transcripts in the observed JSONL shape (Claude Code 2.1.283).
 * All content is invented; no real transcript data is used.
 */
import { writeFile } from "node:fs/promises";
export class TranscriptBuilder {
    opts;
    lines = [];
    n = 0;
    toolN = 0;
    constructor(opts = {}) {
        this.opts = opts;
    }
    lastUuid = null;
    base(type, extra) {
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
    push(rec) {
        this.lines.push(JSON.stringify(rec));
        return this;
    }
    user(text, extra = {}) {
        return this.push(this.base("user", { message: { role: "user", content: text }, ...extra }));
    }
    pasted(authored, pasted, id = "ab12") {
        return this.user(`${authored}\n\n<pasted_content id="${id}">\n${pasted}\n</pasted_content id="${id}">`);
    }
    say(text) {
        return this.push(this.assistant([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }]));
    }
    assistant(content) {
        return this.base("assistant", {
            message: { role: "assistant", model: this.opts.model ?? "claude-opus-5-5", content },
            effort: this.opts.effort ?? "medium",
        });
    }
    /** A non-Bash tool call with an ok or error result. */
    tool(name, input, result = {}) {
        const id = `toolu_${++this.toolN}`;
        this.push(this.assistant([{ type: "tool_use", id, name, input }]));
        const isError = result.error !== undefined;
        const content = isError ? `<tool_use_error>${result.error}</tool_use_error>` : (result.content ?? "ok");
        return this.push(this.base("user", {
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
            toolUseResult: isError ? `Error: ${result.error}` : { filePath: input.file_path },
        }));
    }
    /** A Bash call. `exit` non-zero produces the observed "Exit code N" error shape. */
    bash(command, r = {}) {
        const id = `toolu_${++this.toolN}`;
        this.push(this.assistant([{ type: "tool_use", id, name: "Bash", input: { command, description: "run" } }]));
        if (r.noResult)
            return this;
        const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
        if (r.exit && r.exit !== 0) {
            const content = `Exit code ${r.exit}\n${out}`;
            return this.push(this.base("user", {
                message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] },
                toolUseResult: `Error: ${content}`,
            }));
        }
        return this.push(this.base("user", {
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: r.stdout ?? "", is_error: false }] },
            toolUseResult: { stdout: r.stdout ?? "", stderr: r.stderr ?? "", interrupted: !!r.interrupted },
        }));
    }
    edit(file_path, error) {
        return this.tool("Edit", { file_path, old_string: "a", new_string: "b" }, error ? { error } : {});
    }
    write(file_path) {
        return this.tool("Write", { file_path, content: "x" });
    }
    read(file_path) {
        return this.tool("Read", { file_path }, { content: "file contents" });
    }
    interrupt() {
        return this.user("[Request interrupted by user for tool use]");
    }
    compact() {
        return this.push(this.base("system", { subtype: "compact_boundary", content: "Conversation compacted" }));
    }
    title(t) {
        return this.push({ type: "ai-title", aiTitle: t, sessionId: this.opts.sessionId ?? "11111111-2222-3333-4444-555555555555" });
    }
    raw(line) {
        this.lines.push(line);
        return this;
    }
    toString() {
        return this.lines.join("\n") + "\n";
    }
    async save(path) {
        await writeFile(path, this.toString());
        return path;
    }
}
