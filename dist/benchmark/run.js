/**
 * Phase 6 A/B benchmark runner.
 *
 *   node dist/benchmark/run.js --check                  verify every task: hidden tests fail at start, pass on the reference solution
 *   node dist/benchmark/run.js --compile                compile each task's instruction with frozen v1 (writes compiled.json)
 *   node dist/benchmark/run.js --run [--settings fresh,history] [--reps 2] [--concurrency 3] [--tasks T01,T02]
 *   node dist/benchmark/run.js --report                 summarise results.jsonl into docs/evaluation/phase6-benchmark.md
 *
 * Work directories and raw logs live under $BENCH_DIR (outside the repository).
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { changedPaths, compileFor, fileHashes, renderHistory, runAgent, setupRepo, verify, writeFiles, AGENT_EFFORT, AGENT_MODEL } from "./harness.js";
import { SOLUTIONS } from "./solutions.js";
import { BENCH_TASKS } from "./tasks.js";
const BENCH_DIR = process.env.BENCH_DIR ?? join(tmpdir(), "ccp-bench");
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const flag = (n) => process.argv.includes(n);
const HISTORY_PREFIX = "This continues an earlier Claude Code session in this repository. Here is that conversation so far:\n---\n";
async function check(tasks) {
    let ok = true;
    for (const t of tasks) {
        const root = join(BENCH_DIR, "check", t.id);
        await setupRepo(t, root);
        const before = await verify(t, root);
        await writeFiles(root, SOLUTIONS[t.id] ?? {});
        const after = await verify(t, root);
        const good = !before.pass && after.pass;
        ok &&= good;
        console.log(`${t.id} ${good ? "OK " : "BAD"}  start: ${before.summary}  |  solution: ${after.summary}`);
    }
    process.exitCode = ok ? 0 : 1;
}
async function compileAll(tasks) {
    const out = {};
    for (const t of tasks) {
        const root = join(BENCH_DIR, "compile", t.id);
        await setupRepo(t, root);
        process.stderr.write(`compile ${t.id} … `);
        out[t.id] = await compileFor(t, root, join(BENCH_DIR, "compile-claude-home"));
        process.stderr.write(`${out[t.id].mode} (${(out[t.id].latencyMs / 1000).toFixed(1)}s)\n`);
    }
    await writeFile(join(BENCH_DIR, "compiled.json"), JSON.stringify(out, null, 2));
}
async function runOne(t, setting, condition, rep, compiled) {
    const root = join(BENCH_DIR, "runs", `${t.id}-${setting}-${condition}-${rep}`);
    await setupRepo(t, root);
    const instruction = condition === "raw" ? t.instruction : compiled[t.id].instruction;
    const prompt = setting === "history" ? `${HISTORY_PREFIX}${renderHistory(t, root)}\n---\n\nMy next message:\n${instruction}` : instruction;
    // Claude Code loads CLAUDE.md automatically; --safe-mode doesn't, so both arms get it the same way.
    const claudeMd = t.files["CLAUDE.md"];
    const appendSystem = claudeMd ? `Contents of this project's CLAUDE.md (project instructions):\n${claudeMd}` : undefined;
    const before = await fileHashes(root);
    const m = await runAgent(prompt, root, join(BENCH_DIR, "logs", `${t.id}-${setting}-${condition}-${rep}.jsonl`), appendSystem);
    const changed = changedPaths(before, await fileHashes(root));
    const v = await verify(t, root);
    return {
        ...m, taskId: t.id, category: t.category, setting, condition, rep, success: v.pass, testResult: v.summary,
        changedFiles: changed, unnecessaryChanges: changed.filter((p) => !t.expectedChanges.some((re) => re.test(p))), promptChars: prompt.length,
    };
}
async function runAll(tasks) {
    const compiled = JSON.parse(await readFile(join(BENCH_DIR, "compiled.json"), "utf8"));
    const settings = (arg("--settings") ?? "fresh,history").split(",");
    const reps = Number(arg("--reps") ?? 1);
    const concurrency = Number(arg("--concurrency") ?? 3);
    await mkdir(join(BENCH_DIR, "logs"), { recursive: true });
    const jobs = [];
    for (let rep = 1; rep <= reps; rep++)
        for (const t of tasks)
            for (const setting of settings)
                for (const condition of ["raw", "compiled"]) {
                    if (setting === "history" && rep > Number(arg("--history-reps") ?? 1))
                        continue;
                    jobs.push(async () => {
                        const r = await runOne(t, setting, condition, rep, compiled);
                        await appendFile(join(BENCH_DIR, "results.jsonl"), JSON.stringify(r) + "\n");
                        process.stderr.write(`${t.id} ${setting}/${condition}#${rep}: ${r.success ? "PASS" : "FAIL"} turns=${r.turns} tools=${r.toolCalls} ${r.wallSeconds}s $${r.costUsd.toFixed(3)}\n`);
                    });
                }
    process.stderr.write(`${jobs.length} runs, concurrency ${concurrency}\n`);
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < jobs.length)
            await jobs[next++]();
    }));
}
const median = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!s.length)
        return NaN;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
async function report() {
    const rows = (await readFile(join(BENCH_DIR, "results.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const compiled = JSON.parse(await readFile(join(BENCH_DIR, "compiled.json"), "utf8"));
    const md = ["# Phase 6 A/B benchmark: raw vs compiled instructions", ""];
    const cv = Object.values(compiled)[0];
    md.push(`- Compiler: \`${cv.compilerVersion}\` (tag context-compiler-v1), policy \`${cv.policyVersion}\`, compile effort medium`);
    md.push(`- Agent: Claude Code \`claude -p\`, model ${AGENT_MODEL}, effort ${AGENT_EFFORT}, --safe-mode, identical tool allowlist, 600 s timeout, $1.50 budget cap per run`);
    md.push(`- Success = hidden deterministic verifier passes (written after the run). ${BENCH_TASKS.length} tasks; no subjective tasks.`);
    md.push(`- Date: ${new Date().toISOString()}`, "");
    for (const setting of ["fresh", "history"]) {
        const S = rows.filter((r) => r.setting === setting);
        if (!S.length)
            continue;
        md.push(`## Setting: ${setting === "fresh" ? "fresh agent (as specified: control gets only the raw instruction)" : "in-session approximation (both arms get the prior conversation)"}`, "");
        md.push("| Metric | Raw | Compiled |", "|---|---|---|");
        const R = S.filter((r) => r.condition === "raw"), C = S.filter((r) => r.condition === "compiled");
        const rate = (xs) => `${xs.filter((r) => r.success).length}/${xs.length} (${Math.round((100 * xs.filter((r) => r.success).length) / xs.length)}%)`;
        const med = (xs, f, d = 0) => median(xs.map(f)).toFixed(d);
        md.push(`| Task completion | ${rate(R)} | ${rate(C)} |`);
        md.push(`| Median turns | ${med(R, (r) => r.turns ?? NaN)} | ${med(C, (r) => r.turns ?? NaN)} |`);
        md.push(`| Median tool calls | ${med(R, (r) => r.toolCalls)} | ${med(C, (r) => r.toolCalls)} |`);
        md.push(`| Median tokens in (incl. cache) | ${med(R, (r) => r.tokensIn)} | ${med(C, (r) => r.tokensIn)} |`);
        md.push(`| Median tokens out | ${med(R, (r) => r.tokensOut)} | ${med(C, (r) => r.tokensOut)} |`);
        md.push(`| Median wall time (s) | ${med(R, (r) => r.wallSeconds, 1)} | ${med(C, (r) => r.wallSeconds, 1)} |`);
        md.push(`| Median cost ($) | ${med(R, (r) => r.costUsd, 3)} | ${med(C, (r) => r.costUsd, 3)} |`);
        md.push(`| Failed test/check runs (total) | ${R.reduce((n, r) => n + r.failedAttempts, 0)} | ${C.reduce((n, r) => n + r.failedAttempts, 0)} |`);
        md.push(`| Clarification requests (heuristic) | ${R.filter((r) => r.clarificationRequest).length} | ${C.filter((r) => r.clarificationRequest).length} |`);
        md.push(`| Runs with unnecessary file changes | ${R.filter((r) => r.unnecessaryChanges.length).length} | ${C.filter((r) => r.unnecessaryChanges.length).length} |`);
        md.push(`| Permission denials (total) | ${R.reduce((n, r) => n + r.permissionDenials, 0)} | ${C.reduce((n, r) => n + r.permissionDenials, 0)} |`, "");
        md.push("| Task | Raw result | Compiled result | Turns raw/comp | Tokens in raw/comp (k) | Wall s raw/comp | Notes |", "|---|---|---|---|---|---|---|");
        for (const t of BENCH_TASKS) {
            const r = S.filter((x) => x.taskId === t.id && x.condition === "raw"), c = S.filter((x) => x.taskId === t.id && x.condition === "compiled");
            if (!r.length && !c.length)
                continue;
            const res = (xs) => xs.map((x) => (x.success ? "✓" : "✗")).join(" ");
            const pair = (f, d = 0, k = 1) => `${med(r, (x) => f(x) / k, d)} / ${med(c, (x) => f(x) / k, d)}`;
            const notes = [
                ...r.filter((x) => !x.success).map((x) => `raw#${x.rep}: ${x.testResult}`),
                ...c.filter((x) => !x.success).map((x) => `comp#${x.rep}: ${x.testResult}`),
                ...[...r, ...c].filter((x) => x.unnecessaryChanges.length).map((x) => `${x.condition}#${x.rep} extra: ${x.unnecessaryChanges.join(", ")}`),
                ...[...r, ...c].filter((x) => x.clarificationRequest).map((x) => `${x.condition}#${x.rep} asked for clarification`),
                ...[...r, ...c].filter((x) => x.timedOut).map((x) => `${x.condition}#${x.rep} timed out`),
            ];
            md.push(`| ${t.id} ${t.name} | ${res(r)} | ${res(c)} | ${pair((x) => x.turns ?? NaN)} | ${pair((x) => x.tokensIn, 0, 1000)} | ${pair((x) => x.wallSeconds, 0)} | ${notes.join("; ").replace(/\|/g, "/") || ""} |`);
        }
        md.push("");
    }
    md.push("## Compiled instructions (frozen v1)", "");
    for (const t of BENCH_TASKS) {
        const c = compiled[t.id];
        if (!c)
            continue;
        md.push(`### ${t.id} ${t.name}`, "", `Raw: \`${t.instruction}\``, "", `Compiled (${c.mode}${c.modelCalled ? `, ${(c.latencyMs / 1000).toFixed(1)}s` : ", no model call"}):`, "", "```text", c.instruction, "```", "");
    }
    await writeFile(arg("--out") ?? "docs/evaluation/phase6-benchmark.md", md.join("\n"));
    await writeFile("docs/evaluation/phase6-benchmark-results.json", JSON.stringify({ compiled, rows: rows.map(({ finalText: _f, ...r }) => r) }, null, 2));
    console.log("report written");
}
async function main() {
    const only = arg("--tasks")?.split(",");
    const tasks = BENCH_TASKS.filter((t) => !only || only.includes(t.id));
    await mkdir(BENCH_DIR, { recursive: true });
    if (flag("--check"))
        return check(tasks);
    if (flag("--compile"))
        return compileAll(tasks);
    if (flag("--run"))
        return runAll(tasks);
    if (flag("--report"))
        return report();
    console.log("use --check, --compile, --run or --report");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    await main();
