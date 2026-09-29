/**
 * Phase 7 runner: context recovery (7A), agent handoff (7B), compaction simulation (7C).
 *
 *   node dist/benchmark/phase7.js --check         hidden tests fail at start, pass on reference solutions
 *   node dist/benchmark/phase7.js --compile       compile recovery briefs (frozen v2, handoff mode)
 *   node dist/benchmark/phase7.js --recovery [--reps 2] [--concurrency 3]
 *   node dist/benchmark/phase7.js --handoff [--reps 2]
 *   node dist/benchmark/phase7.js --compaction
 *   node dist/benchmark/phase7.js --report
 *
 * Everything runs under $BENCH_DIR (outside the repository). The compiler is not modified here.
 */
import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, COMPILER_VERSION } from "../compiler/compiler.js";
import { POLICY_VERSION } from "../compiler/policy.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { projectSlug } from "../context/claude-session.js";
import { discoverContext } from "../context/discover.js";
import { TranscriptBuilder } from "../evaluation/transcript-builder.js";
import { ClaudeCliProvider } from "../llm/claude-cli.js";
import { buildContextBundle } from "../selection/pipeline.js";
import { run } from "../util/exec.js";
import { changedPaths, fileHashes, runAgent, setupRepo, writeFiles } from "./harness.js";
import { COMPACTION_CASES, COMPACTION_HEDGE, HANDOFF_TASKS, RECOVERY_TASKS } from "./phase7-tasks.js";
const BENCH_DIR = process.env.BENCH_DIR ?? join(tmpdir(), "ccp-bench7");
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const flag = (n) => process.argv.includes(n);
const asBench = (t) => t;
/* ── transcripts and conversation rendering ── */
const SUMMARY_RECORD = (summary) => JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: summary }, timestamp: new Date(Date.UTC(2026, 8, 1, 11)).toISOString() });
export function diskTranscript(t, root) {
    const b = t.before(new TranscriptBuilder({ cwd: root }), root);
    b.compact().raw(SUMMARY_RECORD(t.summary));
    return t.after(b, root);
}
/** Plain conversation text for a builder, in record order (compaction records skipped). */
export function renderConversation(b) {
    const out = [];
    for (const line of b.toString().split("\n")) {
        if (!line.trim())
            continue;
        const d = JSON.parse(line);
        if (d.isCompactSummary || d.type === "system")
            continue;
        const c = d.message?.content;
        if (d.type === "user" && typeof c === "string" && !d.isMeta)
            out.push(`User: ${c}`);
        if (!Array.isArray(c))
            continue;
        for (const x of c) {
            if (d.type === "assistant" && x.type === "text")
                out.push(`Claude: ${x.text}`);
            if (d.type === "assistant" && x.type === "tool_use") {
                const i = x.input;
                out.push(`Claude used ${x.name}: ${String(i.command ?? i.file_path ?? "")}`);
            }
            if (d.type === "user" && x.type === "tool_result") {
                const text = String(x.content ?? "").trim();
                out.push(`  → ${x.is_error ? "error: " : ""}${text ? text.replace(/\n/g, "\n    ") : "ok"}`);
            }
        }
    }
    return out.join("\n");
}
const FULL_PREFIX = "This continues an earlier Claude Code session in this repository. Here is that conversation so far:\n---\n";
const COMPACT_PREFIX = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
export function recoveryPrompt(t, root, cond, brief) {
    if (cond === "A") {
        const full = t.after(t.before(new TranscriptBuilder({ cwd: root }), root), root);
        return `${FULL_PREFIX}${renderConversation(full)}\n---\n\nMy next message:\n${t.instruction}`;
    }
    const after = renderConversation(t.after(new TranscriptBuilder({ cwd: root }), root));
    return `${COMPACT_PREFIX}${t.summary}\n\nConversation since then:\n${after}\n---\n\nMy next message:\n${cond === "C" ? brief : t.instruction}`;
}
export async function verifyTagged(t, root) {
    await rm(join(root, ".verify"), { recursive: true, force: true });
    await writeFiles(join(root, ".verify"), t.verifier);
    const r = await run(process.execPath, ["--test", "--test-reporter=tap", ...Object.keys(t.verifier).map((f) => join(".verify", f))], { cwd: root, timeoutMs: 120_000 });
    await rm(join(root, ".verify"), { recursive: true, force: true });
    const out = `${r.stdout}\n${r.stderr}`;
    const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((n) => !n.endsWith(".js"));
    const passed = Number(out.match(/^# pass (\d+)/m)?.[1] ?? 0);
    const count = (tag) => failed.filter((f) => f.startsWith(tag)).length;
    return { pass: r.ok && failed.length === 0 && passed > 0, failed, counts: { core: count("[core]"), constraint: count("[constraint]"), noRepeat: count("[no-repeat]") } };
}
async function compileBrief(root, transcript, instruction, keyFacts) {
    const home = join(root, "..", `${root.split("/").pop()}-claude-home`);
    const dir = join(home, "projects", projectSlug(root));
    await rm(home, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${randomUUID()}.jsonl`), typeof transcript === "string" ? transcript : transcript.toString());
    const ctx = await discoverContext({ cwd: root, config: DEFAULT_CONFIG, env: { CCP_CLAUDE_HOME: home }, request: instruction });
    const bundle = buildContextBundle(ctx, instruction, { mode: "handoff" });
    const o = await compile(bundle, {
        provider: new ClaudeCliProvider(), model: DEFAULT_CONFIG.model.name, effort: DEFAULT_CONFIG.model.effort,
        projectRoot: ctx.project.root, claudeHome: home, transcriptPath: ctx.session.detection.transcriptPath,
    });
    return {
        text: o.result.instruction, latencyMs: Math.round(o.timings.modelMs), inputChars: o.input.text.length, selectedIds: o.input.itemIds,
        facts: keyFacts.map((f) => ({ name: f.name, inInput: f.re.test(o.input.text), inBrief: f.re.test(o.result.instruction) })),
        neutralized: o.input.neutralized.map((n) => ({ itemId: n.itemId, lines: n.lines })), scrubbed: o.scrubbed ?? [], warnings: o.result.warnings,
    };
}
async function pool(jobs, concurrency) {
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < jobs.length)
            await jobs[next++]();
    }));
}
async function agentRun(bench, taskId, condition, rep, root, prompt, task) {
    const before = await fileHashes(root);
    const m = await runAgent(prompt, root, join(BENCH_DIR, "logs", `${bench}-${taskId}-${condition}-${rep}.jsonl`));
    const changed = changedPaths(before, await fileHashes(root));
    const v = await verifyTagged(task, root);
    const row = {
        ...m, bench, taskId, condition, rep, success: v.pass, failed: v.failed, incorrectAssumptions: v.counts.constraint, repeatedFailedApproach: v.counts.noRepeat,
        unnecessaryChanges: changed.filter((p) => !task.expectedChanges.some((re) => re.test(p))), promptChars: prompt.length,
    };
    await appendFile(join(BENCH_DIR, "results.jsonl"), JSON.stringify(row) + "\n");
    process.stderr.write(`${bench} ${taskId} ${condition}#${rep}: ${row.success ? "PASS" : `FAIL (${v.failed.join("; ")})`} turns=${m.turns} ${m.wallSeconds}s\n`);
    return row;
}
async function check() {
    let ok = true;
    for (const t of [...RECOVERY_TASKS, ...HANDOFF_TASKS]) {
        const root = join(BENCH_DIR, "check", t.id);
        await setupRepo(asBench(t), root);
        const a = await verifyTagged(t, root);
        await writeFiles(root, t.solution);
        const b = await verifyTagged(t, root);
        const good = !a.pass && b.pass;
        ok &&= good;
        console.log(`${t.id} ${good ? "OK " : "BAD"} start fails: ${a.failed.length} | solution: ${b.pass ? "pass" : b.failed.join("; ")}`);
    }
    process.exitCode = ok ? 0 : 1;
}
async function compileRecovery() {
    const out = {};
    for (const t of RECOVERY_TASKS) {
        const root = join(BENCH_DIR, "compile", t.id);
        await setupRepo(asBench(t), root);
        process.stderr.write(`compile ${t.id} … `);
        out[t.id] = await compileBrief(root, diskTranscript(t, root), t.instruction, t.keyFacts);
        process.stderr.write(`${(out[t.id].latencyMs / 1000).toFixed(1)}s; facts in input ${out[t.id].facts.filter((f) => f.inInput).length}/${t.keyFacts.length}, in brief ${out[t.id].facts.filter((f) => f.inBrief).length}/${t.keyFacts.length}\n`);
    }
    await writeFile(join(BENCH_DIR, "recovery-briefs.json"), JSON.stringify(out, null, 2));
}
async function runRecovery() {
    const briefs = JSON.parse(await readFile(join(BENCH_DIR, "recovery-briefs.json"), "utf8"));
    const reps = Number(arg("--reps") ?? 2);
    const jobs = [];
    for (let rep = 1; rep <= reps; rep++)
        for (const t of RECOVERY_TASKS)
            for (const cond of ["A", "B", "C"])
                jobs.push(async () => {
                    const root = join(BENCH_DIR, "runs", `${t.id}-${cond}-${rep}`);
                    await setupRepo(asBench(t), root);
                    await agentRun("recovery", t.id, cond, rep, root, recoveryPrompt(t, root, cond, briefs[t.id]?.text), t);
                });
    await mkdir(join(BENCH_DIR, "logs"), { recursive: true });
    await pool(jobs, Number(arg("--concurrency") ?? 3));
}
/** Converts `claude -p --output-format stream-json` output plus the prompt into a transcript file. */
export function streamToTranscript(prompt, stream, cwd) {
    const lines = [JSON.stringify({ type: "user", cwd, message: { role: "user", content: prompt } })];
    for (const l of stream.split("\n")) {
        if (!l.trim())
            continue;
        try {
            const d = JSON.parse(l);
            if (d.type === "assistant" || d.type === "user")
                lines.push(JSON.stringify({ ...d, cwd }));
        }
        catch {
            // skip
        }
    }
    return lines.join("\n") + "\n";
}
async function runHandoff() {
    const reps = Number(arg("--reps") ?? 2);
    await mkdir(join(BENCH_DIR, "logs"), { recursive: true });
    const handoffs = {};
    for (const t of HANDOFF_TASKS) {
        const aRoot = join(BENCH_DIR, "handoff", `${t.id}-A`);
        await setupRepo(asBench(t), aRoot);
        const aLog = join(BENCH_DIR, "logs", `handoff-${t.id}-agentA.jsonl`);
        const before = await fileHashes(aRoot);
        const m = await runAgent(t.agentAPrompt, aRoot, aLog);
        const v = await verifyTagged(t, aRoot);
        const agentA = {
            ...m, bench: "handoff", taskId: t.id, condition: "agentA", rep: 1, success: v.pass, failed: v.failed, incorrectAssumptions: v.counts.constraint,
            repeatedFailedApproach: 0, unnecessaryChanges: changedPaths(before, await fileHashes(aRoot)).filter((p) => !t.expectedChanges.some((re) => re.test(p))), promptChars: t.agentAPrompt.length,
        };
        process.stderr.write(`handoff ${t.id} agentA: ${agentA.success ? "PASS" : `partial (${v.failed.join("; ")})`}\n`);
        const transcript = streamToTranscript(t.agentAPrompt, await readFile(aLog, "utf8"), aRoot);
        const brief = await compileBrief(aRoot, transcript, "Continue this task.", t.keyFacts);
        handoffs[t.id] = { agentA, brief };
        const jobs = [];
        for (let rep = 1; rep <= reps; rep++)
            for (const cond of ["continue", "compiled"])
                jobs.push(async () => {
                    const root = join(BENCH_DIR, "handoff", `${t.id}-B-${cond}-${rep}`);
                    await rm(root, { recursive: true, force: true });
                    await cp(aRoot, root, { recursive: true });
                    await agentRun("handoff", t.id, cond, rep, root, cond === "continue" ? "continue this task" : brief.text, t);
                });
        await pool(jobs, Number(arg("--concurrency") ?? 3));
    }
    await writeFile(join(BENCH_DIR, "handoffs.json"), JSON.stringify(handoffs, null, 2));
}
async function runCompaction() {
    const out = {};
    for (const c of COMPACTION_CASES) {
        const root = join(BENCH_DIR, "compaction", c.id);
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "package.json"), '{"name":"x","type":"module"}\n');
        await run("git", ["init", "-q"], { cwd: root });
        const brief = await compileBrief(root, c.transcript(new TranscriptBuilder({ cwd: root }), root), c.instruction, [{ name: "fact", re: c.fact }]);
        const sentences = brief.text.split(/(?<=[.!?])\s+|\n/).filter((s) => c.fact.test(s));
        const recovered = sentences.length > 0;
        const hedged = sentences.some((s) => COMPACTION_HEDGE.test(s));
        const invented = c.invented ? c.invented.test(brief.text) : false;
        const verdict = c.kind === "explicit" ? (recovered ? "recovered" : "MISSED")
            : c.kind === "implied" ? (!recovered ? "MISSED" : invented ? "INVENTED" : hedged ? "recovered, hedged" : "STATED AS FACT")
                : invented ? "INVENTED" : "not invented";
        out[c.id] = { kind: c.kind, brief, recovered, hedged, invented, verdict };
        process.stderr.write(`${c.id} ${c.kind}: ${verdict} (${(brief.latencyMs / 1000).toFixed(1)}s)\n`);
    }
    await writeFile(join(BENCH_DIR, "compaction.json"), JSON.stringify(out, null, 2));
}
const median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return !s.length ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
async function report() {
    const rows = (await readFile(join(BENCH_DIR, "results.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const briefs = JSON.parse(await readFile(join(BENCH_DIR, "recovery-briefs.json"), "utf8"));
    const handoffs = JSON.parse(await readFile(join(BENCH_DIR, "handoffs.json"), "utf8"));
    const compaction = JSON.parse(await readFile(join(BENCH_DIR, "compaction.json"), "utf8"));
    const md = ["# Phase 7 results: context recovery, handoff, compaction", "", `- Compiler \`${COMPILER_VERSION}\` (tag context-compiler-v2), policy \`${POLICY_VERSION}\`, handoff mode, effort medium`, `- Agent: claude -p, claude-opus-5-5, effort medium, --safe-mode, same allowlist/timeout/budget as Phase 6`, `- Date: ${new Date().toISOString()}`, ""];
    const table = (label, groups) => {
        md.push(`### ${label}`, "", `| Metric | ${groups.map((g) => g[0]).join(" | ")} |`, `|---|${groups.map(() => "---").join("|")}|`);
        const rowOf = (name, f) => md.push(`| ${name} | ${groups.map((g) => f(g[1])).join(" | ")} |`);
        rowOf("Task completion", (xs) => `${xs.filter((r) => r.success).length}/${xs.length}`);
        rowOf("Median turns", (xs) => median(xs.map((r) => r.turns ?? NaN)).toFixed(0));
        rowOf("Median tool calls", (xs) => median(xs.map((r) => r.toolCalls)).toFixed(0));
        rowOf("Median tokens in", (xs) => median(xs.map((r) => r.tokensIn)).toFixed(0));
        rowOf("Median tokens out", (xs) => median(xs.map((r) => r.tokensOut)).toFixed(0));
        rowOf("Median wall time (s)", (xs) => median(xs.map((r) => r.wallSeconds)).toFixed(1));
        rowOf("Failed test runs (total)", (xs) => String(xs.reduce((n, r) => n + r.failedAttempts, 0)));
        rowOf("Incorrect assumptions (failed [constraint] tests)", (xs) => String(xs.reduce((n, r) => n + r.incorrectAssumptions, 0)));
        rowOf("Repeated failed approach (failed [no-repeat] tests)", (xs) => String(xs.reduce((n, r) => n + r.repeatedFailedApproach, 0)));
        rowOf("Clarification requests (heuristic)", (xs) => String(xs.filter((r) => r.clarificationRequest).length));
        rowOf("Runs with unnecessary changes", (xs) => String(xs.filter((r) => r.unnecessaryChanges.length).length));
        md.push("");
    };
    const rec = rows.filter((r) => r.bench === "recovery");
    md.push("## 7A Context recovery", "");
    table("All recovery tasks", [["A full history", rec.filter((r) => r.condition === "A")], ["B compacted", rec.filter((r) => r.condition === "B")], ["C compacted + ccp", rec.filter((r) => r.condition === "C")]]);
    md.push("| Task | A | B | C | Facts in compiler input | Facts in brief | Brief latency | Failed tests (B / C) |", "|---|---|---|---|---|---|---|---|");
    for (const t of RECOVERY_TASKS) {
        const r = (c) => rec.filter((x) => x.taskId === t.id && x.condition === c);
        const res = (c) => r(c).map((x) => (x.success ? "✓" : "✗")).join(" ");
        const b = briefs[t.id];
        const fails = (c) => [...new Set(r(c).flatMap((x) => x.failed))].join("; ") || "—";
        md.push(`| ${t.id} ${t.name} | ${res("A")} | ${res("B")} | ${res("C")} | ${b.facts.filter((f) => f.inInput).length}/${b.facts.length} | ${b.facts.filter((f) => f.inBrief).length}/${b.facts.length} | ${(b.latencyMs / 1000).toFixed(1)}s | ${fails("B")} / ${fails("C")} |`.replace(/\n/g, " "));
    }
    md.push("", "### Missed facts (selection or compilation)", "");
    for (const t of RECOVERY_TASKS)
        for (const f of briefs[t.id].facts)
            if (!f.inBrief)
                md.push(`- ${t.id} "${f.name}": ${f.inInput ? "selected but not carried into the brief" : "NOT SELECTED (never reached the compiler)"}`);
    md.push("", "### Recovery briefs", "");
    for (const t of RECOVERY_TASKS)
        md.push(`#### ${t.id} ${t.name}`, "", `Raw: \`${t.instruction}\` · Compaction summary kept: ${t.summary.replace(/\n/g, " ")}`, "", "```text", briefs[t.id].text, "```", "");
    const ho = rows.filter((r) => r.bench === "handoff");
    md.push("## 7B Agent handoff", "");
    table("Agent B", [['"continue this task"', ho.filter((r) => r.condition === "continue")], ["compiled handoff", ho.filter((r) => r.condition === "compiled")]]);
    md.push("| Task | Agent A (partial by design) | B: continue | B: compiled | Facts in brief | Failed tests (continue / compiled) |", "|---|---|---|---|---|---|");
    for (const t of HANDOFF_TASKS) {
        const h = handoffs[t.id];
        const r = (c) => ho.filter((x) => x.taskId === t.id && x.condition === c);
        const fails = (c) => [...new Set(r(c).flatMap((x) => x.failed))].join("; ") || "—";
        md.push(`| ${t.id} ${t.name} | ${h.agentA.success ? "complete" : `${h.agentA.failed.length} tests open`} | ${r("continue").map((x) => (x.success ? "✓" : "✗")).join(" ")} | ${r("compiled").map((x) => (x.success ? "✓" : "✗")).join(" ")} | ${h.brief.facts.filter((f) => f.inBrief).length}/${h.brief.facts.length} | ${fails("continue")} / ${fails("compiled")} |`);
    }
    md.push("", "### Handoff briefs", "");
    for (const t of HANDOFF_TASKS)
        md.push(`#### ${t.id} ${t.name}`, "", "```text", handoffs[t.id].brief.text, "```", "");
    md.push("## 7C Compaction simulation (no agents)", "", "| Case | Kind | Verdict | Latency |", "|---|---|---|---|");
    for (const c of COMPACTION_CASES)
        md.push(`| ${c.id} ${c.note} | ${c.kind} | ${compaction[c.id].verdict} | ${(compaction[c.id].brief.latencyMs / 1000).toFixed(1)}s |`);
    md.push("");
    for (const c of COMPACTION_CASES)
        md.push(`#### ${c.id} (${c.kind}): ${compaction[c.id].verdict}`, "", "```text", compaction[c.id].brief.text, "```", "");
    md.push("## Safety filter activity", "");
    const all = [...RECOVERY_TASKS.map((t) => [t.id, briefs[t.id]]), ...HANDOFF_TASKS.map((t) => [t.id, handoffs[t.id].brief]), ...COMPACTION_CASES.map((c) => [c.id, compaction[c.id].brief])];
    for (const [id, b] of all) {
        for (const n of b.neutralized)
            md.push(`- ${id}: withheld from compiler in ${n.itemId}: ${n.lines.map((l) => `\`${l.slice(0, 120)}\``).join(", ")}`);
        for (const s of b.scrubbed)
            md.push(`- ${id}: scrubbed from output: \`${s.slice(0, 160)}\``);
    }
    if (!all.some(([, b]) => b.neutralized.length || b.scrubbed.length))
        md.push("- No content was withheld or scrubbed in any Phase 7 compilation.");
    md.push("", "## Compiler latency (recovery workflows)", "");
    const lat = all.map(([, b]) => b.latencyMs);
    md.push(`- ${lat.length} compilations: median ${(median(lat) / 1000).toFixed(1)}s, min ${(Math.min(...lat) / 1000).toFixed(1)}s, max ${(Math.max(...lat) / 1000).toFixed(1)}s`);
    await writeFile("docs/evaluation/phase7-results.md", md.join("\n"));
    await writeFile("docs/evaluation/phase7-results.json", JSON.stringify({ rows: rows.map(({ finalText: _f, ...r }) => r), briefs, handoffs, compaction }, null, 2));
    console.log("report written: docs/evaluation/phase7-results.md");
}
async function main() {
    await mkdir(BENCH_DIR, { recursive: true });
    if (flag("--check"))
        return check();
    if (flag("--compile"))
        return compileRecovery();
    if (flag("--recovery"))
        return runRecovery();
    if (flag("--handoff"))
        return runHandoff();
    if (flag("--compaction"))
        return runCompaction();
    if (flag("--report"))
        return report();
    console.log("use --check, --compile, --recovery, --handoff, --compaction or --report");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    await main();
