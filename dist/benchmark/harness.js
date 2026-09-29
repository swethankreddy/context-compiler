/**
 * A/B benchmark harness: builds a task repo, compiles the instruction with the frozen
 * Context Compiler v1, runs Claude Code headlessly, and verifies with hidden tests.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isVerificationCommand } from "../context/analysis/shell.js";
import { projectSlug } from "../context/claude-session.js";
import { discoverContext } from "../context/discover.js";
import { compile, COMPILER_VERSION } from "../compiler/compiler.js";
import { POLICY_VERSION } from "../compiler/policy.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { ClaudeCliProvider } from "../llm/claude-cli.js";
import { budgetFromConfig } from "../selection/budget.js";
import { buildContextBundle } from "../selection/pipeline.js";
import { run } from "../util/exec.js";
export const AGENT_MODEL = "claude-opus-5-5";
export const AGENT_EFFORT = "medium";
export const AGENT_TIMEOUT_MS = 600_000;
export const AGENT_BUDGET_USD = "1.50";
/** Identical tool configuration for every run, both arms. No rm, no network tools. */
export const AGENT_ALLOWED_TOOLS = [
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(node *)", "Bash(npm test*)", "Bash(npm run *)", "Bash(npx *)",
    "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(grep *)", "Bash(find *)",
    "Bash(sed *)", "Bash(echo *)", "Bash(mkdir *)", "Bash(cp *)", "Bash(mv *)", "Bash(diff *)",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
];
export async function writeFiles(root, files) {
    for (const [p, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, p)), { recursive: true });
        await writeFile(join(root, p), content);
    }
}
/** Committed starting state plus the uncommitted work from the prior session. */
export async function setupRepo(task, root) {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeFiles(root, task.files);
    const g = (...a) => run("git", ["-c", "user.email=bench@example.com", "-c", "user.name=bench", ...a], { cwd: root });
    await g("init", "-q", "-b", "main");
    await g("add", "-A");
    await g("commit", "-q", "-m", "initial");
    if (task.sessionChanges)
        await writeFiles(root, task.sessionChanges);
}
export async function fileHashes(root) {
    const out = new Map();
    const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
            if ([".git", "node_modules", ".verify"].includes(e.name))
                continue;
            const p = join(dir, e.name);
            if (e.isDirectory())
                await walk(p);
            else
                out.set(relative(root, p), createHash("sha1").update(await readFile(p)).digest("hex"));
        }
    };
    await walk(root);
    return out;
}
export function changedPaths(before, after) {
    const keys = new Set([...before.keys(), ...after.keys()]);
    return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}
export async function verify(task, root) {
    await rm(join(root, ".verify"), { recursive: true, force: true });
    await writeFiles(join(root, ".verify"), task.verifier);
    const files = Object.keys(task.verifier).map((f) => join(".verify", f));
    const r = await run(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: root, timeoutMs: 120_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const pass = Number(out.match(/^# pass (\d+)/m)?.[1] ?? 0);
    const fail = Number(out.match(/^# fail (\d+)/m)?.[1] ?? 0);
    const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).slice(0, 4);
    await rm(join(root, ".verify"), { recursive: true, force: true });
    return { pass: r.ok && fail === 0 && pass > 0, summary: `${pass} pass, ${fail} fail${failed.length ? ` (${failed.join("; ")})` : ""}` };
}
/** Runs the frozen compiler exactly as `ccp` would, against the task's repo and prior session. */
export async function compileFor(task, root, claudeHome) {
    const dir = join(claudeHome, "projects", projectSlug(root));
    await mkdir(dir, { recursive: true });
    await task.transcript(root).save(join(dir, `${randomUUID()}.jsonl`));
    const ctx = await discoverContext({ cwd: root, config: DEFAULT_CONFIG, env: { CCP_CLAUDE_HOME: claudeHome }, request: task.instruction });
    const bundle = buildContextBundle(ctx, task.instruction, { budget: budgetFromConfig(DEFAULT_CONFIG) });
    const o = await compile(bundle, {
        provider: new ClaudeCliProvider(), model: DEFAULT_CONFIG.model.name, effort: DEFAULT_CONFIG.model.effort,
        projectRoot: ctx.project.root, claudeHome, transcriptPath: ctx.session.detection.transcriptPath,
    });
    return {
        instruction: o.result.instruction, mode: o.result.mode, modelCalled: o.modelCalled, latencyMs: Math.round(o.timings.modelMs),
        warnings: o.result.warnings, selected: bundle.stats.selected, compilerVersion: COMPILER_VERSION, policyVersion: POLICY_VERSION,
    };
}
/** The prior session as plain conversation text, in record order (for the in-session setting). */
export function renderHistory(task, root) {
    const out = [];
    const cmds = new Map();
    for (const line of task.transcript(root).toString().split("\n")) {
        if (!line.trim())
            continue;
        const d = JSON.parse(line);
        const c = d.message?.content;
        if (d.type === "user" && typeof c === "string" && !d.isMeta)
            out.push(`User: ${c}`);
        if (!Array.isArray(c))
            continue;
        for (const b of c) {
            if (d.type === "assistant" && b.type === "text")
                out.push(`Claude: ${b.text}`);
            if (d.type === "assistant" && b.type === "tool_use") {
                const i = b.input;
                const what = String(i.command ?? i.file_path ?? "");
                cmds.set(String(b.id), what);
                out.push(`Claude used ${b.name}: ${what}`);
            }
            if (d.type === "user" && b.type === "tool_result") {
                const text = String(b.content ?? "").trim();
                out.push(`  → ${b.is_error ? "error: " : ""}${text ? text.replace(/\n/g, "\n    ") : "ok"}`);
            }
        }
    }
    return out.join("\n");
}
const CLARIFY = /(which (one|file|form|module|test|bug|issue) (do you|did you|should)|could you (clarify|confirm|tell me|share|point)|can you (clarify|confirm|tell me|share|point)|do you want me to|would you like me to|should i\b|what (exactly )?do you mean|please (clarify|specify|confirm)|let me know (which|what|if))/i;
export async function runAgent(prompt, root, logPath, appendSystem) {
    const args = [
        "-p", "--output-format", "stream-json", "--verbose", "--safe-mode", "--no-session-persistence",
        "--model", AGENT_MODEL, "--effort", AGENT_EFFORT, "--permission-mode", "dontAsk",
        "--tools", "Bash,Read,Edit,Write,Glob,Grep", "--allowedTools", ...AGENT_ALLOWED_TOOLS,
        "--max-budget-usd", AGENT_BUDGET_USD,
        ...(appendSystem ? ["--append-system-prompt", appendSystem] : []),
    ];
    const started = Date.now();
    const { code, stdout, timedOut } = await new Promise((resolve) => {
        const child = spawn("claude", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
        let out = "", to = false;
        const timer = setTimeout(() => ((to = true), child.kill("SIGTERM")), AGENT_TIMEOUT_MS);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", () => { });
        child.on("close", (c) => (clearTimeout(timer), resolve({ code: c, stdout: out, timedOut: to })));
        child.on("error", () => (clearTimeout(timer), resolve({ code: -1, stdout: out, timedOut: to })));
        child.stdin.end(prompt);
    });
    await writeFile(logPath, stdout);
    let toolCalls = 0, failedAttempts = 0;
    const commands = new Map();
    let final = null;
    for (const line of stdout.split("\n")) {
        if (!line.trim())
            continue;
        let d;
        try {
            d = JSON.parse(line);
        }
        catch {
            continue;
        }
        const msg = d.message;
        if (d.type === "assistant" && Array.isArray(msg?.content)) {
            for (const b of msg.content) {
                if (b.type !== "tool_use")
                    continue;
                toolCalls++;
                const input = b.input;
                if (b.name === "Bash" && typeof input?.command === "string")
                    commands.set(String(b.id), input.command);
            }
        }
        if (d.type === "user" && Array.isArray(msg?.content)) {
            for (const b of msg.content) {
                const cmd = commands.get(String(b.tool_use_id));
                if (b.type === "tool_result" && b.is_error === true && cmd && (isVerificationCommand(cmd) || /\bnode\s+--test\b/.test(cmd)))
                    failedAttempts++;
            }
        }
        if (d.type === "result")
            final = d;
    }
    const u = (final?.usage ?? {});
    const finalText = typeof final?.result === "string" ? final.result : "";
    return {
        exitCode: code, timedOut, subtype: final?.subtype ?? null, turns: final?.num_turns ?? null, toolCalls,
        tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0, costUsd: final?.total_cost_usd ?? 0,
        wallSeconds: Math.round((Date.now() - started) / 100) / 10, failedAttempts,
        permissionDenials: Array.isArray(final?.permission_denials) ? final.permission_denials.length : 0,
        clarificationRequest: CLARIFY.test(finalText.split("\n").slice(-6).join("\n")),
        finalText: finalText.slice(0, 1500),
    };
}
