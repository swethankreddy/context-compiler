/**
 * Runs the fresh compiler evaluation against the real `claude -p` backend and writes a
 * raw-vs-compiled report. Calls the model once per case (uses Claude usage).
 *
 * Usage: npm run eval:compiler -- [--set 1|2] [--efforts low,medium] [--out path.md] [--only A,B]
 */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compile, type CompileOutcome } from "../compiler/compiler.js";
import { POLICY_VERSION } from "../compiler/policy.js";
import type { Effort } from "../config/config.js";
import { ClaudeCliProvider } from "../llm/claude-cli.js";
import { buildContextBundle } from "../selection/pipeline.js";
import { EVAL_ROOT } from "./snapshot-factory.js";
import { checkCompilerCase, COMPILER_CASES, type CompilerCase } from "./compiler-cases.js";
import { COMPILER_CASES_2 } from "./compiler-cases-2.js";
import { COMPILER_VERSION } from "../compiler/compiler.js";

interface Row {
  id: string;
  name: string;
  raw: string;
  compiled: string;
  mode: string;
  errors: string[];
  contextUsed: string[];
  warnings: string[];
  selected: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  modelCalled: boolean;
  failure?: string;
  intent: string;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function runEffort(cases: CompilerCase[], effort: Effort): Promise<Row[]> {
  const provider = new ClaudeCliProvider();
  const rows: Row[] = [];
  for (const c of cases) {
    process.stderr.write(`[${effort}] ${c.id} ${c.name} … `);
    const bundle = buildContextBundle(await c.snapshot(), c.instruction);
    const base = { id: c.id, name: c.name, raw: c.instruction, intent: c.intent, selected: bundle.stats.selected };
    let o: CompileOutcome;
    try {
      o = await compile(bundle, { provider, model: "claude-opus-5-5", effort, projectRoot: EVAL_ROOT });
    } catch (e) {
      rows.push({ ...base, compiled: "", mode: "-", errors: ["compile failed (invalid or no output)"], contextUsed: [], warnings: [], latencyMs: 0, modelCalled: true, failure: (e as Error).message });
      process.stderr.write("FAILED\n");
      continue;
    }
    const errors = checkCompilerCase(c, o.result, `${c.instruction}\n${o.input.text}`);
    rows.push({
      ...base, compiled: o.result.instruction, mode: o.result.mode, errors, contextUsed: o.result.contextUsed, warnings: o.result.warnings,
      latencyMs: Math.round(o.timings.modelMs), inputTokens: (o.response?.usage?.inputTokens ?? 0) + (o.response?.usage?.cacheCreationTokens ?? 0) + (o.response?.usage?.cacheReadTokens ?? 0),
      outputTokens: o.response?.usage?.outputTokens, costUsd: o.response?.costUsd, modelCalled: o.modelCalled,
    });
    process.stderr.write(`${errors.length ? "CHECKS FAILED" : "ok"} (${(o.timings.modelMs / 1000).toFixed(1)}s)\n`);
  }
  return rows;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

function summary(rows: Row[]) {
  const called = rows.filter((r) => r.modelCalled && !r.failure);
  return {
    passed: rows.filter((r) => !r.errors.length).length,
    valid: rows.filter((r) => !r.failure).length,
    medLatency: median(called.map((r) => r.latencyMs)),
    maxLatency: Math.max(0, ...called.map((r) => r.latencyMs)),
    medOut: median(called.map((r) => r.outputTokens ?? 0)),
    medChars: median(called.map((r) => r.compiled.length)),
    cost: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  };
}

async function main() {
  const set = arg("--set") ?? "1";
  const cases = (set === "2" ? COMPILER_CASES_2 : COMPILER_CASES).filter((c) => !(arg("--only")?.split(",")) || arg("--only")!.split(",").includes(c.id));
  const efforts = (arg("--efforts") ?? arg("--effort") ?? "medium").split(",") as Effort[];
  const outPath = arg("--out") ?? `docs/evaluation/compiler-eval-set${set}-${efforts.join("-")}.md`;
  const byEffort = new Map<Effort, Row[]>();
  for (const e of efforts) byEffort.set(e, await runEffort(cases, e));

  const md: string[] = [
    `# Compiler evaluation — set ${set} (fresh)`,
    "",
    `- Compiler: \`${COMPILER_VERSION}\`, policy \`${POLICY_VERSION}\``,
    `- Model: claude-opus-5-5 via \`claude -p\`; efforts: ${efforts.join(", ")}`,
    `- Date: ${new Date().toISOString()}`,
    "",
    "Automatic checks: required mentions, forbidden content (including injected instructions), mode, length, minimality (no generic boilerplate), hedging of inferred facts, and file paths absent from the input. They do not judge overall usefulness; read the pairs below.",
    "",
    "| Effort | Checks passed | Valid output | Median latency | Max latency | Median output tokens | Median chars | Cost |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [e, rows] of byEffort) {
    const s = summary(rows);
    md.push(`| ${e} | ${s.passed}/${rows.length} | ${s.valid}/${rows.length} | ${(s.medLatency / 1000).toFixed(1)}s | ${(s.maxLatency / 1000).toFixed(1)}s | ${s.medOut} | ${s.medChars} | $${s.cost.toFixed(3)} |`);
  }
  md.push("", "| Case | " + efforts.map((e) => `${e}: checks / mode / chars / latency / out tok`).join(" | ") + " |", "|---|" + efforts.map(() => "---").join("|") + "|");
  for (const c of cases) {
    md.push(`| ${c.id} ${c.name} | ` + efforts.map((e) => {
      const r = byEffort.get(e)!.find((x) => x.id === c.id)!;
      return `${r.errors.length ? `✗ ${r.errors.join("; ")}` : "✓"} / ${r.mode} / ${r.compiled.length} / ${(r.latencyMs / 1000).toFixed(1)}s / ${r.outputTokens ?? "-"}`;
    }).join(" | ") + " |");
  }
  md.push("");
  for (const c of cases) {
    md.push(`## ${c.id}. ${c.name}`, "", `**Good compilation:** ${c.intent}`, "", "**Raw**", "", "```text", c.instruction, "```", "");
    for (const e of efforts) {
      const r = byEffort.get(e)!.find((x) => x.id === c.id)!;
      md.push(`**Compiled — ${e}** (${r.mode})`, "", "```text", r.failure ? `FAILED: ${r.failure}` : r.compiled, "```", "");
      if (r.warnings.length) md.push(`Warnings: ${r.warnings.join(" · ")}`, "");
      if (r.errors.length) md.push(`Check failures: ${r.errors.join(" · ")}`, "");
    }
  }
  await writeFile(outPath, md.join("\n"));
  for (const [e, rows] of byEffort) {
    const s = summary(rows);
    console.log(`${e}: ${s.passed}/${rows.length} checks · ${s.valid}/${rows.length} valid · median ${(s.medLatency / 1000).toFixed(1)}s · median out ${s.medOut} tok · $${s.cost.toFixed(3)}`);
  }
  console.log(`report: ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
