/**
 * Report + review packet for a handoff validation run (used for human-authored and
 * Claude-authored task sets alike; the label says which).
 *
 * Condition names follow the Phase 11 protocol:
 *   continuation — fresh agent receives only the next message ("continue this task")   [runner code B]
 *   handoff      — fresh agent receives the `ccp --handoff` brief                     [runner code C]
 *   reference    — fresh agent receives the full relevant history                     [runner code A]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalTask, HandoffPrepared, Row } from "./external.js";

const NAME: Record<string, string> = { B: "continuation", C: "handoff", A: "reference (full history)" };
const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return !s.length ? NaN : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export const REVIEW_CHECKLIST = [
  ["OBJECTIVE", "Was the actual objective preserved?"],
  ["REQUIREMENTS", "Were important requirements preserved?"],
  ["EXACT VALUES", "Were numbers, formats, limits, names and IDs preserved?"],
  ["DECISIONS", "Were important decisions preserved?"],
  ["FAILED APPROACHES", "Were relevant rejected approaches preserved?"],
  ["VERIFICATION", "Was verified work distinguished from assumptions?"],
  ["TASK SCOPE", "Was the overall task preserved?"],
  ["PREVIOUS AGENT SCOPE", "Were Agent A's restrictions kept separate?"],
  ["REMAINING", "Is the remaining work accurate?"],
  ["UNKNOWN", "Are unknowns genuinely unknown?"],
  ["BLOCKING", "Are only genuinely blocking unknowns marked blocking?"],
  ["INVENTION", "Did the handoff invent anything?"],
  ["SUPERSESSION", "Are old values clearly marked as superseded?"],
  ["SECURITY", "Did useful technical information survive without exposing sensitive values?"],
] as const;

export async function writeHandoffReport(tasks: ExternalTask[], work: string, opts: { label: string; out: string; packet: string; compiler: string; policy: string }): Promise<void> {
  const rows = (await readFile(join(work, "results.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Row);
  const prepared = JSON.parse(await readFile(join(work, "handoff-prepared.json"), "utf8")) as Record<string, HandoffPrepared>;
  const conds = ["B", "C", "A"].filter((c) => rows.some((r) => (r.condition as string) === c));
  const compileTokens = (id: string) => (prepared[id]?.brief.compileTokensIn ?? 0) + (prepared[id]?.brief.compileTokensOut ?? 0);
  const compileCost = (id: string) => prepared[id]?.brief.compileCostUsd ?? 0;
  const md: string[] = [`# Handoff validation — ${opts.label}`, "", `- Compiler \`${opts.compiler}\`, policy \`${opts.policy}\``, `- Date: ${new Date().toISOString()}`, `- Tasks: ${tasks.length}`, ""];
  md.push("## Results", "", "| Condition | Runs | Success | Median turns | Median tool calls | Median tokens in / out | Median wall s | Failed test runs | Wrong assumptions | Repeated failed approaches | Clarifications | Unnecessary changes |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of conds) {
    const R = rows.filter((r) => (r.condition as string) === c);
    md.push(`| ${NAME[c]} | ${R.length} | ${R.filter((r) => r.success).length}/${R.length} | ${median(R.map((r) => r.turns ?? NaN))} | ${median(R.map((r) => r.toolCalls))} | ${Math.round(median(R.map((r) => r.tokensIn)))} / ${Math.round(median(R.map((r) => r.tokensOut)))} | ${median(R.map((r) => r.wallSeconds)).toFixed(1)} | ${R.reduce((n, r) => n + r.failedAttempts, 0)} | ${R.reduce((n, r) => n + r.wrongAssumptions, 0)} | ${R.reduce((n, r) => n + r.repeatedFailedApproaches, 0)} | ${R.filter((r) => r.clarificationRequest).length} | ${R.filter((r) => r.unnecessaryChanges.length).length} |`);
  }
  md.push("", "## Cost to success", "", "Totals include every run (failed runs too) and, for the handoff condition, the compiler call per run.", "", "| Condition | Successes | Total tokens | Tokens per success | Total cost | **Cost per success** | Tokens in failed runs | Median tokens per successful run |", "|---|---|---|---|---|---|---|---|");
  for (const c of conds) {
    const R = rows.filter((r) => (r.condition as string) === c);
    const tok = (r: Row) => r.tokensIn + r.tokensOut + (c === "C" ? compileTokens(r.taskId) : 0);
    const cost = (r: Row) => r.costUsd + (c === "C" ? compileCost(r.taskId) : 0);
    const S = R.filter((r) => r.success);
    const T = R.reduce((n, r) => n + tok(r), 0), $ = R.reduce((n, r) => n + cost(r), 0);
    md.push(`| ${NAME[c]} | ${S.length}/${R.length} | ${T} | ${S.length ? Math.round(T / S.length) : "no successes"} | $${$.toFixed(2)} | ${S.length ? `$${($ / S.length).toFixed(3)}` : "no successes"} | ${R.filter((r) => !r.success).reduce((n, r) => n + tok(r), 0)} | ${S.length ? Math.round(median(S.map(tok))) : "—"} |`);
  }
  md.push("", "## Per task", "", `| Task | ${conds.map((c) => NAME[c]).join(" | ")} | Failing hidden tests | Brief compile |`, `|---|${conds.map(() => "---").join("|")}|---|---|`);
  for (const t of tasks) {
    const cell = (c: string) => rows.filter((r) => r.taskId === t.id && (r.condition as string) === c).map((r) => (r.success ? "✓" : "✗")).join(" ");
    const fails = conds.map((c) => {
      const f = [...new Set(rows.filter((r) => r.taskId === t.id && (r.condition as string) === c).flatMap((r) => r.failed))];
      return f.length ? `${NAME[c]}: ${f.slice(0, 3).join("; ")}` : "";
    }).filter(Boolean).join(" · ");
    const p = prepared[t.id];
    md.push(`| ${t.id} | ${conds.map(cell).join(" | ")} | ${fails.replace(/\|/g, "/")} | ${p ? `${(p.brief.latencyMs / 1000).toFixed(1)} s, ${compileTokens(t.id)} tok` : "—"} |`);
  }
  md.push("", "## Failure categories (fill in after reading each failing run's log)", "", "retrieval miss · safety filtering · reconstruction error · compiler error · genuinely unavailable context · task under-specification · agent error unrelated to context", "");
  await writeFile(opts.out, md.join("\n"));

  const pk: string[] = [`# Handoff review packet — ${opts.label}`, "", "For each task: read the source session (`session-script/session.json`, or `README.md` for a summary), then the brief the fresh agent received. Record concrete examples, not just marks.", ""];
  for (const t of tasks) {
    const p = prepared[t.id];
    if (!p) continue;
    pk.push(`## ${t.id}`, "", `Session: \`${t.dir}/session-script/session.json\``, "", "<details><summary>Handoff brief</summary>", "", "```text", p.brief.text, "```", "</details>", "", "| Check | Question | ✓ / ✗ | Concrete example |", "|---|---|---|---|", ...REVIEW_CHECKLIST.map(([k, q]) => `| ${k} | ${q} | | |`), "");
  }
  await writeFile(opts.packet, pk.join("\n"));
  console.log(`report: ${opts.out}\nreview packet: ${opts.packet}`);
}
