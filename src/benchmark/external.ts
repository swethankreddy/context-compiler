/**
 * Runner for externally defined benchmark tasks (benchmark/tasks/<id>/, see benchmark/FORMAT.md).
 * Task definitions are data; nothing here is task-specific.
 *
 *   node dist/benchmark/external.js --check [--task id]       validate task definitions (no model calls)
 *   node dist/benchmark/external.js --prepare [--task id]     real /compact of each session + ccp briefs (model calls)
 *   node dist/benchmark/external.js --run [--reps 2] [--concurrency 3] [--task id]
 *   node dist/benchmark/external.js --report
 *   node dist/benchmark/external.js --cleanup                 delete the generated ~/.claude/projects entries
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import { changedPaths, fileHashes, runAgent, type AgentMetrics } from "./harness.js";

export const TASKS_DIR = process.env.BENCH_TASKS ?? join(process.cwd(), "benchmark", "tasks");
const WORK = process.env.BENCH_DIR ?? join(tmpdir(), "ccp-bench8");
const arg = (n: string): string | undefined => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const flag = (n: string) => process.argv.includes(n);

/* ───────── task loading ───────── */

export type FactKind = "objective" | "constraint" | "correction" | "failed-approach" | "decision" | "verification" | "remaining" | "unavailable" | "previous-agent-scope" | "next-step";
/** `stale`: for corrections, the superseded value; a brief stating it without the correction is DISTORTED. */
export interface Fact { name: string; kind: FactKind; pattern: string; invented?: string; stale?: string }
export type SessionEvent =
  | { user: string; pasted?: string }
  | { claude: string }
  | { read: string; content?: string }
  | { write: string; content: string }
  | { edit: string; old: string; new: string }
  | { bash: string; exit?: number; output?: string }
  | { compact: true };

export interface ExternalTask {
  id: string;
  dir: string;
  /** "handoff": no compaction point; a fresh agent continues from Agent A's session. */
  mode: "recovery" | "handoff";
  title: string;
  category: string;
  instruction: string;
  expectedChanges: RegExp[];
  facts: Fact[];
  events: SessionEvent[];
  files: Record<string, string>;
  sessionChanges: Record<string, string>;
  hiddenTests: Record<string, string>;
  solution: Record<string, string>;
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith("._") || e.name === ".DS_Store") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[relative(dir, p)] = await readFile(p, "utf8");
    }
  };
  await walk(dir);
  return out;
}

export async function loadTask(dir: string): Promise<ExternalTask> {
  const meta = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
  const session = JSON.parse(await readFile(join(dir, "session-script", "session.json"), "utf8")) as { events: SessionEvent[] };
  return {
    id: String(meta.id),
    dir,
    mode: meta.mode === "handoff" ? "handoff" : "recovery",
    title: String(meta.title ?? meta.id),
    category: String(meta.category ?? ""),
    instruction: String(meta.instruction ?? "continue"),
    expectedChanges: ((meta.expectedChanges as string[]) ?? []).map((r) => new RegExp(r)),
    facts: (meta.facts as Fact[]) ?? [],
    events: session.events,
    files: await readTree(join(dir, "repository")),
    sessionChanges: await readTree(join(dir, "session-changes")),
    hiddenTests: await readTree(join(dir, "hidden-tests")),
    solution: await readTree(join(dir, "reference-solution")),
  };
}

export async function loadTasks(only?: string): Promise<ExternalTask[]> {
  const ids = (await readdir(TASKS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  return Promise.all(ids.filter((id) => !only || only.split(",").includes(id)).map((id) => loadTask(join(TASKS_DIR, id))));
}

/* ───────── repositories and verification ───────── */

async function writeTree(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), c);
  }
}

export async function setupTaskRepo(t: ExternalTask, root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeTree(root, t.files);
  const g = (...a: string[]) => run("git", ["-c", "user.email=bench@example.com", "-c", "user.name=bench", ...a], { cwd: root });
  await g("init", "-q", "-b", "main");
  await g("add", "-A");
  await g("commit", "-q", "-m", "initial");
  await writeTree(root, t.sessionChanges);
}

export interface Verification { pass: boolean; failed: string[]; constraint: number; noRepeat: number; ran: number }

export async function verifyHidden(t: ExternalTask, root: string): Promise<Verification> {
  await rm(join(root, ".verify"), { recursive: true, force: true });
  await writeTree(join(root, ".verify"), t.hiddenTests);
  const files = Object.keys(t.hiddenTests).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).map((f) => join(".verify", f));
  const r = await run(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: root, timeoutMs: 120_000 });
  await rm(join(root, ".verify"), { recursive: true, force: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]!.trim()).filter((n) => !/\.(m?js)$/.test(n));
  const ran = Number(out.match(/^# tests (\d+)/m)?.[1] ?? 0);
  const count = (tag: string) => failed.filter((f) => f.startsWith(tag)).length;
  return { pass: r.ok && failed.length === 0 && ran > 0, failed, constraint: count("[constraint]"), noRepeat: count("[no-repeat]"), ran };
}

/* ───────── sessions ───────── */

/** Builds a Claude Code transcript from session events (paths are made absolute under `root`). */
export function buildTranscript(t: ExternalTask, root: string, events: SessionEvent[], b = new TranscriptBuilder({ cwd: root })): TranscriptBuilder {
  const repoFile = (p: string) => t.sessionChanges[p] ?? t.files[p] ?? "";
  for (const e of events) {
    if ("compact" in e) b.compact();
    else if ("user" in e) e.pasted ? b.pasted(e.user, e.pasted) : b.user(e.user);
    else if ("claude" in e) b.say(e.claude);
    else if ("read" in e) b.tool("Read", { file_path: join(root, e.read) }, { content: e.content ?? repoFile(e.read) });
    else if ("write" in e) b.tool("Write", { file_path: join(root, e.write), content: e.content }, { content: `File created successfully at: ${join(root, e.write)}` });
    else if ("edit" in e) b.tool("Edit", { file_path: join(root, e.edit), old_string: e.old, new_string: e.new }, { content: `The file ${join(root, e.edit)} has been updated.` });
    else if ("bash" in e) b.bash(e.bash, { exit: e.exit, stdout: e.output ?? "" });
  }
  return b;
}

export const splitAtCompact = (events: SessionEvent[]) => {
  const i = events.findIndex((e) => "compact" in e);
  return i === -1 ? { before: events, after: [] } : { before: events.slice(0, i), after: events.slice(i + 1) };
};

/** Human-readable conversation (paths relative to the repository). */
export function renderEvents(events: SessionEvent[]): string {
  const out: string[] = [];
  for (const e of events) {
    if ("compact" in e) continue;
    if ("user" in e) out.push(`User: ${e.user}${e.pasted ? `\n[pasted]\n${e.pasted}\n[/pasted]` : ""}`);
    else if ("claude" in e) out.push(`Claude: ${e.claude}`);
    else if ("read" in e) out.push(`Claude used Read: ${e.read}`);
    else if ("write" in e) out.push(`Claude used Write: ${e.write}\n${e.content}`);
    else if ("edit" in e) out.push(`Claude used Edit: ${e.edit}\n  - ${e.old.replace(/\n/g, "\n    ")}\n  + ${e.new.replace(/\n/g, "\n    ")}`);
    else if ("bash" in e) out.push(`Claude used Bash: ${e.bash}\n  → ${e.exit ? `exit ${e.exit}: ` : ""}${(e.output ?? "ok").replace(/\n/g, "\n    ")}`);
  }
  return out.join("\n");
}

const eventText = (events: SessionEvent[]) => events.map((e) => JSON.stringify(e)).join("\n");

/* ───────── --check ───────── */

export async function checkTask(t: ExternalTask): Promise<{ ok: boolean; problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  const compacts = t.events.filter((e) => "compact" in e).length;
  if (t.mode === "recovery" && compacts !== 1) problems.push(`session must contain exactly one compact event (found ${compacts})`);
  if (t.mode === "handoff" && compacts !== 0) problems.push("handoff tasks must not contain a compact event");
  if (!Object.keys(t.hiddenTests).length) problems.push("hidden-tests/ is empty");
  if (!Object.keys(t.solution).length) problems.push("reference-solution/ is empty");
  if (!t.files["package.json"]) problems.push("repository/package.json missing");
  const { before, after } = splitAtCompact(t.events);
  if (before.length < 12) notes.push(`only ${before.length} events in the session (aim for 15–40)`);
  const beforeText = eventText(before), allText = eventText(t.events);
  const repoText = Object.values({ ...t.files, ...t.sessionChanges }).join("\n");
  for (const f of t.facts) {
    let re: RegExp;
    try {
      re = new RegExp(f.pattern, "i");
    } catch (e) {
      problems.push(`fact "${f.name}": invalid pattern (${(e as Error).message})`);
      continue;
    }
    if (f.kind === "unavailable") {
      if (f.invented && re.test("") ) problems.push(`fact "${f.name}": pattern matches empty text`);
      if (f.invented && new RegExp(f.invented, "i").test(allText)) problems.push(`unavailable fact "${f.name}": its invented value appears in the session`);
    } else {
      if (!re.test(beforeText)) problems.push(`fact "${f.name}" (${f.kind}) does not appear ${t.mode === "handoff" ? "in the session" : "before compact"}`);
      if (re.test(eventText(after))) notes.push(`fact "${f.name}" is repeated after compact (still visible to the compacted agent)`);
      if (re.test(repoText)) notes.push(`fact "${f.name}" is also recoverable from the repository`);
    }
  }
  const root = join(WORK, "check", t.id);
  await setupTaskRepo(t, root);
  const start = await verifyHidden(t, root);
  if (start.ran === 0) problems.push("hidden tests did not run on the starting state");
  if (start.pass) problems.push("hidden tests already pass on the starting state");
  await writeTree(root, t.solution);
  const sol = await verifyHidden(t, root);
  if (!sol.pass) problems.push(`reference solution fails: ${sol.failed.join("; ") || "(no tests ran)"}`);
  const tags = Object.values(t.hiddenTests).join("\n");
  if (!/\[constraint\]/.test(tags)) notes.push("no [constraint] tests");
  await rm(root, { recursive: true, force: true });
  return { ok: problems.length === 0, problems, notes };
}

/* ───────── --prepare: real compaction + ccp briefs ───────── */

export interface Prepared {
  taskId: string;
  workdir: string;
  sessionId: string;
  transcriptPath: string;
  compactSummary: string;
  recover: Brief;
  handoff: Brief;
}
export interface Brief {
  text: string; latencyMs: number; selectedIds: string[]; neutralized: string[]; scrubbed: string[]; warnings: string[]; inputChars: number;
  /** Compiler call usage (for tokens-to-success). */
  compileTokensIn?: number; compileTokensOut?: number; compileCostUsd?: number;
}

function claudeCompact(sessionId: string, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--resume", sessionId, "--safe-mode", "--tools", "", "--model", DEFAULT_CONFIG.model.name, "/compact"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}

async function compileBrief(t: ExternalTask, root: string, transcript: string, mode: "recover" | "handoff", instructionOverride?: string): Promise<Brief> {
  const home = join(WORK, "ccp-home", `${t.id}-${mode}`);
  await rm(home, { recursive: true, force: true });
  const dir = join(home, "projects", projectSlug(root));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.jsonl"), transcript);
  const instruction = instructionOverride ?? (mode === "recover" ? t.instruction : "Continue this task.");
  const ctx = await discoverContext({ cwd: root, config: DEFAULT_CONFIG, env: { CCP_CLAUDE_HOME: home }, request: instruction });
  const bundle = buildContextBundle(ctx, instruction, { mode: "handoff" });
  const o = await compile(bundle, {
    provider: new ClaudeCliProvider(), model: DEFAULT_CONFIG.model.name, effort: DEFAULT_CONFIG.model.effort,
    projectRoot: ctx.project.root, claudeHome: home, transcriptPath: ctx.session.detection.transcriptPath,
  });
  return {
    text: o.result.instruction, latencyMs: Math.round(o.timings.modelMs), selectedIds: o.input.itemIds,
    neutralized: o.input.neutralized.flatMap((n) => n.lines), scrubbed: o.scrubbed ?? [], warnings: o.result.warnings, inputChars: o.input.text.length,
    compileTokensIn: (o.response?.usage?.inputTokens ?? 0) + (o.response?.usage?.cacheReadTokens ?? 0) + (o.response?.usage?.cacheCreationTokens ?? 0),
    compileTokensOut: o.response?.usage?.outputTokens ?? 0, compileCostUsd: o.response?.costUsd,
  };
}

export async function prepareTask(t: ExternalTask): Promise<Prepared> {
  const workdir = join(WORK, "work", t.id);
  await setupTaskRepo(t, workdir);
  const { before, after } = splitAtCompact(t.events);
  const sessionId = randomUUID();
  const slugDir = join(homedir(), ".claude", "projects", projectSlug(workdir));
  await mkdir(slugDir, { recursive: true });
  const transcriptPath = join(slugDir, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, buildTranscript(t, workdir, before, new TranscriptBuilder({ cwd: workdir, sessionId })).toString());
  const c = await claudeCompact(sessionId, workdir);
  const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
  const summaryRec = lines.map((l) => JSON.parse(l) as Record<string, unknown>).reverse().find((d) => d.isCompactSummary === true);
  if (!summaryRec) throw new Error(`${t.id}: /compact produced no summary (exit ${c.code}): ${c.out.slice(0, 300)}`);
  const content = (summaryRec.message as { content: unknown }).content;
  const compactSummary = typeof content === "string" ? content : (content as { text: string }[]).map((x) => x.text).join("\n");
  // Continue the same session after compaction with the visible tail.
  const tail = buildTranscript(t, workdir, after, new TranscriptBuilder({ cwd: workdir, sessionId }));
  await appendFile(transcriptPath, tail.toString());
  const transcript = await readFile(transcriptPath, "utf8");
  const recover = await compileBrief(t, workdir, transcript, "recover");
  const handoff = await compileBrief(t, workdir, transcript, "handoff");
  return { taskId: t.id, workdir, sessionId, transcriptPath, compactSummary, recover, handoff };
}

/* ───────── --run ───────── */

export type Condition = "A" | "B" | "C" | "D" | "E";
export interface Row extends AgentMetrics {
  taskId: string;
  condition: Condition;
  rep: number;
  success: boolean;
  failed: string[];
  wrongAssumptions: number;
  repeatedFailedApproaches: number;
  unnecessaryChanges: string[];
  promptChars: number;
}

const FULL = "This continues an earlier Claude Code session in this repository. Here is that conversation so far:\n---\n";

export function promptFor(t: ExternalTask, p: Prepared, c: Condition): string {
  const { after } = splitAtCompact(t.events);
  const tail = after.length ? `\n\n${renderEvents(after)}` : "";
  switch (c) {
    case "A":
      return `${FULL}${renderEvents(t.events)}\n---\n\nMy next message:\n${t.instruction}`;
    case "B":
      return `${p.compactSummary}${tail}\n\nMy next message:\n${t.instruction}`;
    case "C":
      return `${p.compactSummary}${tail}\n\nMy next message:\n${p.recover.text}`;
    case "D":
      return "continue this task";
    case "E":
      return p.handoff.text;
  }
}

async function runOne(t: ExternalTask, p: Prepared, c: Condition, rep: number): Promise<Row> {
  const root = join(WORK, "runs", `${t.id}-${c}-${rep}`);
  await setupTaskRepo(t, root);
  const prompt = promptFor(t, p, c);
  const claudeMd = t.files["CLAUDE.md"] ?? t.files["AGENTS.md"];
  const before = await fileHashes(root);
  const m = await runAgent(prompt, root, join(WORK, "logs", `${t.id}-${c}-${rep}.jsonl`), claudeMd ? `Contents of this project's CLAUDE.md (project instructions):\n${claudeMd}` : undefined);
  const changed = changedPaths(before, await fileHashes(root));
  const v = await verifyHidden(t, root);
  await rm(root, { recursive: true, force: true });
  return {
    ...m, taskId: t.id, condition: c, rep, success: v.pass, failed: v.failed, wrongAssumptions: v.constraint, repeatedFailedApproaches: v.noRepeat,
    unnecessaryChanges: changed.filter((x) => !t.expectedChanges.some((re) => re.test(x))), promptChars: prompt.length,
  };
}

/* ───────── fact coverage (recovery quality) ───────── */

export interface Coverage { name: string; kind: FactKind; inSummary: boolean; inRecover: boolean; inHandoff: boolean; invented: { summary: boolean; recover: boolean; handoff: boolean } }

export function coverage(t: ExternalTask, p: Prepared): Coverage[] {
  return t.facts.map((f) => {
    const re = new RegExp(f.pattern, "i");
    const inv = f.invented ? new RegExp(f.invented, "i") : null;
    return {
      name: f.name, kind: f.kind,
      inSummary: re.test(p.compactSummary), inRecover: re.test(p.recover.text), inHandoff: re.test(p.handoff.text),
      invented: { summary: !!inv?.test(p.compactSummary), recover: !!inv?.test(p.recover.text), handoff: !!inv?.test(p.handoff.text) },
    };
  });
}

/* ───────── handoff suite (Phase 9): A full history · B "continue this task" · C ccp --handoff ───────── */

export interface HandoffPrepared { taskId: string; workdir: string; brief: Brief & { fidelity?: unknown } }
export type HCondition = "A" | "B" | "C";

/** Supplementary mode: every condition gets the task author's own next message instead of "continue this task". */
const USE_TASK_INSTRUCTION = process.argv.includes("--use-task-instruction");
const nextMessage = (t: ExternalTask) => (USE_TASK_INSTRUCTION ? t.instruction : "continue this task");

export async function prepareHandoff(t: ExternalTask): Promise<HandoffPrepared> {
  const workdir = join(WORK, "work", t.id);
  await setupTaskRepo(t, workdir);
  const transcript = buildTranscript(t, workdir, t.events).toString();
  const brief = await compileBrief(t, workdir, transcript, "handoff", USE_TASK_INSTRUCTION ? t.instruction : undefined);
  return { taskId: t.id, workdir, brief };
}

export function handoffPrompt(t: ExternalTask, p: HandoffPrepared, c: HCondition): string {
  if (c === "A") return `${FULL}${renderEvents(t.events)}\n---\n\nMy next message:\n${nextMessage(t)}`;
  if (c === "B") return nextMessage(t);
  return p.brief.text;
}

export type Fidelity = "PRESERVED" | "DROPPED" | "DISTORTED" | "INVENTED";
const ABSENCE_CLAIM = /\b(never|did not|didn't) (stated|said|mentioned|specified|asked for|state|say|mention|specify)\b|not in the developer's own words/i;

/** Per-fact audit of a brief. DISTORTED: a superseded value stated without the correction, or an absence claim about the fact. */
export function auditBrief(t: ExternalTask, brief: string): { name: string; kind: FactKind; verdict: Fidelity; note?: string }[] {
  return t.facts.map((f) => {
    const re = new RegExp(f.pattern, "i");
    if (f.kind === "unavailable") {
      const inv = f.invented ? new RegExp(f.invented, "i") : null;
      return { name: f.name, kind: f.kind, verdict: inv?.test(brief) ? "INVENTED" : "PRESERVED", note: "unavailable fact: PRESERVED means no value was invented" };
    }
    const has = re.test(brief);
    const stale = f.stale ? new RegExp(f.stale, "i").test(brief) : false;
    if (!has && stale) return { name: f.name, kind: f.kind, verdict: "DISTORTED", note: "superseded value stated without the correction" };
    const sentence = brief.split(/(?<=[.!?])\s+|\n/).find((x) => re.test(x));
    if (has && sentence && ABSENCE_CLAIM.test(sentence)) return { name: f.name, kind: f.kind, verdict: "DISTORTED", note: "absence claim" };
    return { name: f.name, kind: f.kind, verdict: has ? "PRESERVED" : "DROPPED" };
  });
}

async function runHandoffOne(t: ExternalTask, p: HandoffPrepared, c: HCondition, rep: number): Promise<Row> {
  const root = join(WORK, "runs", `${t.id}-${c}-${rep}`);
  await setupTaskRepo(t, root);
  const prompt = handoffPrompt(t, p, c);
  const claudeMd = t.files["CLAUDE.md"] ?? t.files["AGENTS.md"];
  const before = await fileHashes(root);
  const m = await runAgent(prompt, root, join(WORK, "logs", `${t.id}-${c}-${rep}.jsonl`), claudeMd ? `Contents of this project's CLAUDE.md (project instructions):\n${claudeMd}` : undefined);
  const changed = changedPaths(before, await fileHashes(root));
  const v = await verifyHidden(t, root);
  await rm(root, { recursive: true, force: true });
  return {
    ...m, taskId: t.id, condition: c as unknown as Condition, rep, success: v.pass, failed: v.failed, wrongAssumptions: v.constraint, repeatedFailedApproaches: v.noRepeat,
    unnecessaryChanges: changed.filter((x) => !t.expectedChanges.some((re) => re.test(x))), promptChars: prompt.length,
  };
}

async function diskFree(): Promise<number> {
  const r = await run("df", ["-k", WORK]);
  const cols = r.stdout.trim().split("\n").pop()!.split(/\s+/);
  return Number(cols[3]) * 1024;
}

async function main() {
  await mkdir(WORK, { recursive: true });
  const tasks = await loadTasks(arg("--task"));
  if (flag("--check")) {
    let ok = true;
    for (const t of tasks) {
      const r = await checkTask(t);
      ok &&= r.ok;
      console.log(`${r.ok ? "OK " : "BAD"} ${t.id}`);
      for (const p of r.problems) console.log(`   ✗ ${p}`);
      for (const n of r.notes) console.log(`   · ${n}`);
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (flag("--prepare")) {
    const out: Record<string, Prepared> = {};
    try {
      Object.assign(out, JSON.parse(await readFile(join(WORK, "prepared.json"), "utf8")));
    } catch {
      // first run
    }
    for (const t of tasks) {
      process.stderr.write(`prepare ${t.id} … `);
      out[t.id] = await prepareTask(t);
      await writeFile(join(WORK, "prepared.json"), JSON.stringify(out, null, 2));
      process.stderr.write(`summary ${out[t.id]!.compactSummary.length} chars; recover ${(out[t.id]!.recover.latencyMs / 1000).toFixed(1)}s; handoff ${(out[t.id]!.handoff.latencyMs / 1000).toFixed(1)}s\n`);
    }
    return;
  }
  if (flag("--run")) {
    const free = await diskFree();
    const need = tasks.length * 5 * Number(arg("--reps") ?? 2) * 2 * 1024 * 1024;
    if (free < need + 500 * 1024 * 1024) {
      console.error(`Not enough disk space: ${(free / 1e9).toFixed(2)} GB free, need about ${((need + 5e8) / 1e9).toFixed(2)} GB. Stopping.`);
      process.exitCode = 1;
      return;
    }
    const prepared = JSON.parse(await readFile(join(WORK, "prepared.json"), "utf8")) as Record<string, Prepared>;
    await mkdir(join(WORK, "logs"), { recursive: true });
    const conds = (arg("--conditions") ?? "A,B,C,D,E").split(",") as Condition[];
    const jobs: (() => Promise<void>)[] = [];
    for (let rep = 1; rep <= Number(arg("--reps") ?? 2); rep++)
      for (const t of tasks)
        for (const c of conds)
          jobs.push(async () => {
            const r = await runOne(t, prepared[t.id]!, c, rep);
            await appendFile(join(WORK, "results.jsonl"), JSON.stringify(r) + "\n");
            process.stderr.write(`${t.id} ${c}#${rep}: ${r.success ? "PASS" : `FAIL (${r.failed.join("; ").slice(0, 160)})`} turns=${r.turns} ${r.wallSeconds}s\n`);
          });
    let next = 0;
    await Promise.all(Array.from({ length: Number(arg("--concurrency") ?? 3) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }));
    return;
  }
  if (flag("--handoff-prepare")) {
    const out: Record<string, HandoffPrepared> = {};
    for (const t of tasks) {
      process.stderr.write(`handoff brief ${t.id} … `);
      out[t.id] = await prepareHandoff(t);
      await writeFile(join(WORK, "handoff-prepared.json"), JSON.stringify(out, null, 2));
      process.stderr.write(`${(out[t.id]!.brief.latencyMs / 1000).toFixed(1)}s, ${out[t.id]!.brief.text.length} chars\n`);
    }
    return;
  }
  if (flag("--handoff-run")) {
    const free = await diskFree();
    if (free < 1e9) {
      console.error(`Not enough disk space (${(free / 1e9).toFixed(2)} GB free). Stopping.`);
      process.exitCode = 1;
      return;
    }
    const prepared = JSON.parse(await readFile(join(WORK, "handoff-prepared.json"), "utf8")) as Record<string, HandoffPrepared>;
    await mkdir(join(WORK, "logs"), { recursive: true });
    const jobs: (() => Promise<void>)[] = [];
    for (let rep = 1; rep <= Number(arg("--reps") ?? 2); rep++)
      for (const t of tasks)
        for (const c of (arg("--conditions") ?? "A,B,C").split(",") as HCondition[])
          jobs.push(async () => {
            const r = await runHandoffOne(t, prepared[t.id]!, c, rep);
            await appendFile(join(WORK, "results.jsonl"), JSON.stringify(r) + "\n");
            process.stderr.write(`${t.id} ${c}#${rep}: ${r.success ? "PASS" : `FAIL (${r.failed.join("; ").slice(0, 160)})`} turns=${r.turns} ${r.wallSeconds}s\n`);
          });
    let next = 0;
    await Promise.all(Array.from({ length: Number(arg("--concurrency") ?? 3) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }));
    return;
  }
  if (flag("--handoff-report")) {
    const { writeHandoffReport } = await import("./handoff-report.js");
    await writeHandoffReport(tasks, WORK, {
      label: arg("--label") ?? "unlabelled task set",
      out: arg("--out") ?? join(WORK, "report.md"),
      packet: arg("--packet") ?? join(WORK, "review-packet.md"),
      compiler: COMPILER_VERSION, policy: POLICY_VERSION,
    });
    return;
  }
  if (flag("--cleanup")) {
    const prepared = JSON.parse(await readFile(join(WORK, "prepared.json"), "utf8")) as Record<string, Prepared>;
    for (const p of Object.values(prepared)) {
      const dir = join(homedir(), ".claude", "projects", projectSlug(p.workdir));
      try {
        await stat(dir);
        await rm(dir, { recursive: true, force: true });
        console.log(`removed ${dir}`);
      } catch {
        // already gone
      }
    }
    return;
  }
  if (flag("--report")) {
    const { writeReport } = await import("./external-report.js");
    await writeReport(tasks, WORK, { compiler: COMPILER_VERSION, policy: POLICY_VERSION }, coverage);
    return;
  }
  console.log("use --check, --prepare, --run, --report or --cleanup");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

