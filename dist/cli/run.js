import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { defaultClipboard } from "../clipboard/clipboard.js";
import { compile } from "../compiler/compiler.js";
import { EFFORT_LEVELS, loadConfig } from "../config/config.js";
import { claudeHome } from "../context/claude-session.js";
import { createProvider } from "../llm/index.js";
import { discoverContext } from "../context/discover.js";
import { renderContextReport } from "../context/report.js";
import { budgetFromConfig } from "../selection/budget.js";
import { buildContextBundle } from "../selection/pipeline.js";
import { renderBundle } from "../selection/render.js";
import { createProgress } from "./progress.js";
export const VERSION = "0.1.0";
const HELP = `ccp — compile a short instruction against your current Claude Code session

Usage:
  ccp "fix the auth issue"     compile, copy to clipboard
  ccp                          prompt for the instruction interactively
  ccp context [--json]         show everything discovered (nothing is sent anywhere)
  ccp context --selected "fix the auth issue" [--json] [--content]
                               show which context would be selected for an instruction

Options:
  --preview         show the context summary and the instruction; do not copy
  --print           write only the instruction to stdout (no progress output)
  --no-copy         do not copy to the clipboard
  --session <id>    use this Claude Code session instead of auto-detecting
  --effort <level>  override the configured effort (low, medium, high, xhigh, max)
  --show-input      print the compiler's system prompt, input and timings to stderr
  --recover         rebuild the task state after compaction or an interruption
                    (instruction defaults to "Continue from where you left off.")
  --handoff         write a handoff brief for a fresh agent that lacks the conversation
                    (instruction defaults to "Continue this task.")
  -h, --help        show this help
  -v, --version     show version
`;
async function readInstruction(io) {
    if (io.stdin.isTTY) {
        const rl = createInterface({ input: io.stdin, output: io.stderr });
        try {
            return await rl.question("Instruction: ");
        }
        finally {
            rl.close();
        }
    }
    let data = "";
    for await (const chunk of io.stdin)
        data += chunk;
    return data;
}
export async function run(argv, io) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                preview: { type: "boolean" },
                print: { type: "boolean" },
                "no-copy": { type: "boolean" },
                session: { type: "string" },
                json: { type: "boolean" },
                selected: { type: "boolean" },
                content: { type: "boolean" },
                effort: { type: "string" },
                "show-input": { type: "boolean" },
                handoff: { type: "boolean" },
                recover: { type: "boolean" },
                help: { type: "boolean", short: "h" },
                version: { type: "boolean", short: "v" },
            },
        });
    }
    catch (e) {
        io.stderr.write(`ccp: ${e.message}\n\n${HELP}`);
        return 2;
    }
    const { values, positionals } = parsed;
    if (values.help)
        return io.stdout.write(HELP), 0;
    if (values.version)
        return io.stdout.write(`${VERSION}\n`), 0;
    const config = await loadConfig(io.env);
    const isContext = positionals[0] === "context";
    const quiet = !!values.print || (isContext && !!values.json);
    const progress = createProgress(io.stderr, quiet);
    if (isContext) {
        const request = positionals.slice(1).join(" ").trim();
        if (request && !values.selected) {
            io.stderr.write("ccp: an instruction after `context` requires --selected\n");
            return 2;
        }
        const ctx = await discoverContext({ cwd: io.cwd, config, env: io.env, sessionId: values.session, request: request || null, progress });
        if (values.selected) {
            progress.start("select", "Selecting context");
            const bundle = buildContextBundle(ctx, request, { budget: budgetFromConfig(config) });
            progress.done("select", `Selected ${bundle.stats.selected} of ${bundle.stats.discovered} candidates`);
            io.stdout.write(values.json ? `${JSON.stringify(bundle, null, 2)}\n` : `\n${renderBundle(bundle, { showContent: !!values.content })}\n`);
            return 0;
        }
        io.stdout.write(values.json ? `${JSON.stringify(ctx, null, 2)}\n` : `\n${renderContextReport(ctx)}\n`);
        return 0;
    }
    const reconstruct = !!(values.handoff || values.recover);
    const instruction = (positionals.length ? positionals.join(" ") : values.handoff ? "Continue this task." : values.recover ? "Continue from where you left off." : await readInstruction(io)).trim();
    if (!instruction) {
        io.stderr.write("ccp: no instruction given\n");
        return 2;
    }
    const t0 = performance.now();
    const ctx = await discoverContext({ cwd: io.cwd, config, env: io.env, sessionId: values.session, request: instruction, progress, ...(reconstruct ? { reconstruct: true } : {}) });
    const t1 = performance.now();
    progress.start("select", "Selecting context");
    const bundle = reconstruct
        ? buildContextBundle(ctx, instruction, { mode: "handoff" })
        : buildContextBundle(ctx, instruction, { budget: budgetFromConfig(config) });
    const t2 = performance.now();
    progress.done("select", `Selected ${bundle.stats.selected} of ${bundle.stats.discovered} candidates (~${bundle.budget.estimatedTokens} tokens)`);
    const effort = (values.effort ?? config.model.effort);
    if (!EFFORT_LEVELS.includes(effort)) {
        io.stderr.write(`ccp: --effort must be one of ${EFFORT_LEVELS.join(", ")}\n`);
        return 2;
    }
    let outcome;
    progress.start("compile", `Compiling instruction (${config.model.name}, effort ${effort})`);
    try {
        outcome = await compile(bundle, {
            provider: createProvider(config, io.env),
            model: config.model.name,
            effort,
            timeoutMs: config.compiler.timeout_ms,
            maxTotalChars: config.compiler.max_input_chars,
            projectRoot: ctx.project.root,
            claudeHome: claudeHome(io.env),
            transcriptPath: ctx.session.detection.transcriptPath,
        });
    }
    catch (e) {
        progress.done("compile", "Compilation failed");
        const err = e;
        io.stderr.write(`ccp: ${err.message}${err.detail ? `\n  ${err.detail}` : ""}${err.raw ? `\n  output: ${err.raw}` : ""}\nNothing was copied.\n`);
        return 1;
    }
    const t3 = performance.now();
    const { result } = outcome;
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
    progress.done("compile", outcome.modelCalled ? `Instruction compiled: ${result.mode} (${secs(outcome.timings.modelMs)})` : "No relevant context: instruction unchanged (no model call)");
    const timings = {
        discoveryMs: Math.round(t1 - t0), selectionMs: Math.round(t2 - t1), renderMs: Math.round(outcome.timings.renderMs),
        compilerMs: Math.round(outcome.timings.modelMs), totalMs: Math.round(t3 - t0),
    };
    if (values["show-input"]) {
        io.stderr.write(`\n── compiler system prompt (${outcome.policy.version}) ──\n${outcome.system}\n\n── compiler input ──\n${outcome.input.text}\n`);
        if (outcome.input.redactions.length)
            io.stderr.write(`── redactions: ${JSON.stringify(outcome.input.redactions)}\n`);
        if (outcome.input.dropped.length)
            io.stderr.write(`── dropped: ${JSON.stringify(outcome.input.dropped)}\n`);
        if (outcome.input.neutralized.length)
            io.stderr.write(`── withheld from the compiler: ${JSON.stringify(outcome.input.neutralized)}\n`);
        if (outcome.scrubbed?.length)
            io.stderr.write(`── scrubbed from the output: ${JSON.stringify(outcome.scrubbed)}\n`);
        io.stderr.write(`── timings: ${JSON.stringify(timings)}${outcome.response ? ` usage: ${JSON.stringify(outcome.response.usage)} cost: ${outcome.response.costUsd ?? "?"}` : ""}\n\n`);
    }
    for (const w of result.warnings)
        if (!values.print)
            io.stderr.write(`! ${w}\n`);
    if (values.preview) {
        io.stdout.write(`\n${renderBundle(bundle, { showContent: true })}\n\nCOMPILED (${result.mode}; policy ${outcome.policy.version}; context used: ${result.contextUsed.join(", ") || "none"})\n${result.instruction}\n\nTIMINGS ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(" · ")}\n`);
        return 0;
    }
    if (values.print)
        io.stdout.write(`${result.instruction}\n`);
    const shouldCopy = config.clipboard.enabled && !values["no-copy"];
    if (shouldCopy) {
        try {
            await (io.clipboard ?? defaultClipboard()).copy(result.instruction);
            progress.done("clipboard", `Copied to clipboard (total ${secs(timings.totalMs)})`);
        }
        catch (e) {
            io.stderr.write(`ccp: could not copy to clipboard: ${e.message}\n`);
            if (!values.print)
                io.stdout.write(`${result.instruction}\n`);
            return 1;
        }
    }
    else if (!values.print) {
        io.stdout.write(`${result.instruction}\n`);
    }
    return 0;
}
