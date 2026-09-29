/**
 * LLMProvider backed by the user's authenticated Claude Code CLI (`claude -p`).
 *
 * Isolation (so the compile call never becomes "the user's session", and sees only what we send):
 *   --no-session-persistence   no transcript is written under ~/.claude/projects
 *   cwd = fresh temp directory  even if a transcript were written, it lands in a throwaway project folder
 *   --safe-mode                 no CLAUDE.md, hooks, plugins, skills or MCP servers; auth works normally
 *   --tools ""                  no tools: the compiler only reads its input and answers
 *   --strict-mcp-config         no MCP servers from any configuration
 *   --system-prompt             replaces Claude Code's default agent prompt
 * Credentials are never read by ccp: the CLI authenticates itself.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "./provider.js";
export const DEFAULT_TIMEOUT_MS = 120_000;
export function claudeCliArgs(req) {
    return [
        "-p",
        "--no-session-persistence",
        "--safe-mode",
        "--tools", "",
        "--strict-mcp-config",
        "--model", req.model,
        "--effort", req.effort,
        "--system-prompt", req.system,
        "--output-format", "json",
        ...(req.jsonSchema ? ["--json-schema", JSON.stringify(req.jsonSchema)] : []),
    ];
}
export class ClaudeCliProvider {
    opts;
    name = "claude-cli";
    constructor(opts = {}) {
        this.opts = opts;
    }
    async complete(req) {
        const cwd = await mkdtemp(join(this.opts.scratchDir ?? tmpdir(), "ccp-compile-"));
        const started = performance.now();
        try {
            const { code, stdout, stderr, timedOut } = await this.exec(claudeCliArgs(req), req.user, cwd, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            const latencyMs = Math.round(performance.now() - started);
            if (timedOut)
                throw new ProviderError(`claude -p timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`);
            let out;
            try {
                out = JSON.parse(stdout);
            }
            catch {
                throw new ProviderError(`claude -p exited ${code} without JSON output`, (stderr || stdout).slice(0, 800));
            }
            if (code !== 0 || out.is_error === true || out.subtype !== "success") {
                const reason = [out.subtype, out.stop_reason, out.terminal_reason, out.api_error_status].filter(Boolean).join(", ");
                throw new ProviderError(`claude -p failed (exit ${code}${reason ? `; ${reason}` : ""})`, String(out.result ?? stderr).slice(0, 800));
            }
            const u = (out.usage ?? {});
            const models = Object.keys((out.modelUsage ?? {}));
            return {
                text: typeof out.result === "string" ? out.result : "",
                ...(out.structured_output !== undefined ? { structured: out.structured_output } : {}),
                model: models[0] ?? req.model,
                latencyMs,
                usage: {
                    inputTokens: u.input_tokens,
                    outputTokens: u.output_tokens,
                    cacheReadTokens: u.cache_read_input_tokens,
                    cacheCreationTokens: u.cache_creation_input_tokens,
                },
                ...(typeof out.total_cost_usd === "number" ? { costUsd: out.total_cost_usd } : {}),
            };
        }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
    }
    exec(args, input, cwd, timeoutMs) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.opts.bin ?? "claude", args, { cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
            let stdout = "", stderr = "", timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
            }, timeoutMs);
            child.stdout.on("data", (d) => (stdout += d));
            child.stderr.on("data", (d) => (stderr += d));
            child.on("error", (e) => {
                clearTimeout(timer);
                reject(new ProviderError(`could not start claude: ${e.message}`));
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code, stdout, stderr, timedOut });
            });
            child.stdin.end(input);
        });
    }
}
