/**
 * Phase 8 §12: real Claude Code sessions on real work in this project (observational).
 *
 * Each scenario runs a genuine multi-turn `claude -p` session in a scratch clone of this repo,
 * then continues it two ways from the same snapshot: without ccp and with ccp. Hidden checks
 * (vitest) were written before any run. Nothing is applied to the real repository.
 *
 *   node dist/benchmark/real-sessions.js --run [--scenario S1]
 *   node dist/benchmark/real-sessions.js --cleanup
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectSlug } from "../context/claude-session.js";
import { run } from "../util/exec.js";
import { AGENT_ALLOWED_TOOLS } from "./harness.js";

const REPO = process.cwd();
const WORK = process.env.BENCH_DIR ?? join(tmpdir(), "ccp-real");
const arg = (n: string): string | undefined => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);

interface Scenario {
  id: string;
  kind: "compaction" | "handoff" | "interruption";
  /** Developer messages to Agent A, in order (each is a real turn). */
  turns: string[];
  /** compaction: the next message after /compact. handoff/interruption: the raw message to the fresh agent. */
  next: string;
  hiddenTest: string;
}

const HELPERS = `import { PassThrough, Readable } from "node:stream";
import { mkdir, writeFile, mkdtemp, realpath, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
const tmp = async (p) => realpath(await mkdtemp(join(tmpdir(), p)));
async function fakeBin() {
  const d = await tmp("hb-"); const b = join(d, "claude");
  await writeFile(b, "#!" + process.execPath + "\\nconst a=process.argv.slice(2);if(a[0]==='--version'){console.log('2.1.283 (Claude Code)');process.exit(0)}let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{if(process.env.CCP_FAKE_LOG)require('fs').writeFileSync(process.env.CCP_FAKE_LOG,JSON.stringify(a));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'',structured_output:{version:1,instruction:'COMPILED',mode:'direct',contextUsed:[],warnings:[]},usage:{},modelUsage:{}}));});");
  await chmod(b, 0o755); return b;
}
async function exec(argv, env, cwd, copied = []) {
  const stdout = new PassThrough(), stderr = new PassThrough(); let out = "", err = "";
  stdout.on("data", (d) => (out += d)); stderr.on("data", (d) => (err += d));
  const code = await run(argv, { stdin: Readable.from([""]), stdout, stderr, env, cwd, clipboard: { name: "t", copy: async (t) => void copied.push(t) } });
  return { code, out, err, copied };
}
async function projectWithSession() {
  const cwd = await tmp("hp-"); const home = await tmp("hh-");
  const dir = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "11111111-2222-3333-4444-555555555555.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "fix the login bug in src/login.ts" } }) + "\\n" + JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(cwd, "src/login.ts"), old_string: "a", new_string: "b" } }] } }) + "\\n" + JSON.stringify({ type: "user", cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } }) + "\\n");
  return { cwd, home, env: { CCP_CLAUDE_HOME: home, CCP_CONFIG_DIR: await tmp("hc-"), CCP_CLAUDE_BIN: await fakeBin() } };
}
`;

export const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    kind: "compaction",
    turns: [
      "Add a `ccp doctor` subcommand that prints a short environment report for the current directory. Don't implement yet: first look at how the CLI in src/cli/run.ts is structured and tell me your plan in a few lines.",
      "Plan is fine. Requirements: one line per check, formatted `name: value`, and the check names must be exactly `claude`, `git`, `session`, `transcript`, in that order. `session` is the detection method (e.g. live-session, recent-transcript, none). Exit code 0 normally, 1 if the claude CLI can't be found. doctor must never read or print anything from ~/.claude except what session detection already reads. Implement it now with a test in test/doctor.test.ts, and run the tests.",
      "One correction, and don't implement it yet, just acknowledge: the `transcript` line must show only the transcript's file name (like `abc123.jsonl`), not the full path, or `none` when there is no session. Also doctor needs to appear in the --help text. I'm going to lunch — we'll finish after.",
    ],
    next: "ok, I'm back — continue",
    hiddenTest: `${HELPERS}
import { test, expect } from "vitest";
test("[core] doctor prints the four checks in order", async () => {
  const p = await projectWithSession();
  const r = await exec(["doctor"], p.env, p.cwd);
  const names = r.out.trim().split("\\n").map((l) => l.split(":")[0].trim()).filter(Boolean);
  expect(names).toEqual(["claude", "git", "session", "transcript"]);
  expect(r.code).toBe(0);
});
test("[constraint] transcript shows only the file name", async () => {
  const p = await projectWithSession();
  const r = await exec(["doctor"], p.env, p.cwd);
  const line = r.out.split("\\n").find((l) => l.startsWith("transcript:"));
  expect(line?.trim()).toBe("transcript: 11111111-2222-3333-4444-555555555555.jsonl");
});
test("[constraint] exit code 1 when claude is missing", async () => {
  const p = await projectWithSession();
  const r = await exec(["doctor"], { ...p.env, CCP_CLAUDE_BIN: "/nonexistent/claude" }, p.cwd);
  expect(r.code).toBe(1);
});
test("[constraint] doctor is in --help", async () => {
  const r = await exec(["--help"], {}, process.cwd());
  expect(r.out).toMatch(/doctor/);
});
`,
  },
  {
    id: "S2",
    kind: "handoff",
    turns: [
      "I want a --json flag for the compile command (the default `ccp \"instruction\"` path in src/cli/run.ts): instead of copying, it prints the compiler result as a single JSON object on stdout with exactly these keys: instruction, mode, contextUsed, warnings, policyVersion, compilerVersion. With --json it must never touch the clipboard and must print nothing else on stdout (progress stays on stderr). Step 1 only for now: write the tests for this in test/json-flag.test.ts (they should fail), run them to confirm they fail, and stop. Someone else will do the implementation.",
    ],
    next: "continue this task",
    hiddenTest: `${HELPERS}
import { test, expect } from "vitest";
test("[core] --json prints the compiler result as JSON", async () => {
  const p = await projectWithSession();
  const r = await exec(["--json", "fix the login bug"], p.env, p.cwd);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.instruction).toBe("COMPILED");
});
test("[constraint] exactly the six keys", async () => {
  const p = await projectWithSession();
  const j = JSON.parse((await exec(["--json", "fix the login bug"], p.env, p.cwd)).out);
  expect(Object.keys(j).sort()).toEqual(["compilerVersion", "contextUsed", "instruction", "mode", "policyVersion", "warnings"]);
});
test("[constraint] never touches the clipboard", async () => {
  const p = await projectWithSession();
  const r = await exec(["--json", "fix the login bug"], p.env, p.cwd);
  expect(r.copied).toEqual([]);
});
`,
  },
  {
    id: "S3",
    kind: "interruption",
    turns: [
      "Add a --max-tokens option that overrides the selection token budget, for both `ccp context --selected` and the compile command. Valid values are integers from 500 to 20000; anything else must exit with code 2 and an error message that mentions max-tokens. Do only the argument parsing and validation now, with a test, and stop — I want to review that before you wire it into selection.",
    ],
    next: "I'm back after the weekend — continue where we left off",
    hiddenTest: `${HELPERS}
import { test, expect } from "vitest";
test("[core] --max-tokens sets the selection budget", async () => {
  const p = await projectWithSession();
  const r = await exec(["context", "--selected", "--json", "--max-tokens", "800", "fix the login bug"], p.env, p.cwd);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).budget.maxTokens).toBe(800);
});
test("[constraint] out-of-range values exit 2 mentioning max-tokens", async () => {
  const p = await projectWithSession();
  for (const v of ["100", "20001", "abc"]) {
    const r = await exec(["context", "--selected", "--max-tokens", v, "x"], p.env, p.cwd);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/max-tokens/);
  }
});
test("[constraint] boundaries 500 and 20000 are accepted", async () => {
  const p = await projectWithSession();
  for (const v of ["500", "20000"]) expect((await exec(["context", "--selected", "--json", "--max-tokens", v, "x"], p.env, p.cwd)).code).toBe(0);
});
`,
  },
];

/** Phase 9 smoke tests: every scenario ends in a FRESH session, with and without `ccp --handoff`. */
export const P9_SCENARIOS: Scenario[] = [
  {
    id: "H1",
    kind: "handoff",
    turns: [
      "I want to be able to filter the `ccp context --selected` output by candidate type. Look at src/cli/run.ts and src/selection/render.ts and tell me how you'd add a `--type` option. Don't change anything yet.",
      "OK, go with that. Rules: `--type` takes a comma-separated list of candidate types (e.g. `attempt,failure`). It filters only the selected list (the text view and the JSON `selected` array); `omitted` stays unfiltered, and the current instruction is always kept. An unknown type must exit with code 2 and an error that lists the valid types. Implement the option parsing and validation now, with a test in test/type-filter.test.ts.",
      "Correction: the filtered list must keep the selection rank order, not the order given in --type. And `--type` without `--selected` must also exit 2 with a message that mentions --selected. Just acknowledge this, don't change the code — I'm handing the rest to another session.",
    ],
    next: "continue this task",
    hiddenTest: `${HELPERS}
import { test, expect } from "vitest";
const sel = async (extra) => { const p = await projectWithSession(); return exec(["context", "--selected", "--json", ...extra, "fix the login bug"], p.env, p.cwd); };
test("[core] --type filters selected by type, keeping the current instruction", async () => {
  const r = await sel(["--type", "attempt,confirmed_change"]);
  expect(r.code).toBe(0);
  const b = JSON.parse(r.out);
  expect(b.selected.every((s) => s.id === "current_instruction" || ["attempt", "confirmed_change"].includes(s.type))).toBe(true);
  expect(b.selected[0].id).toBe("current_instruction");
});
test("[constraint] omitted stays unfiltered", async () => {
  const all = JSON.parse((await sel([])).out); const f = JSON.parse((await sel(["--type", "attempt"])).out);
  expect(f.omitted.length).toBe(all.omitted.length);
});
test("[constraint] rank order is kept", async () => {
  const b = JSON.parse((await sel(["--type", "confirmed_change,attempt"])).out);
  const ranks = b.selected.map((s) => s.rank); expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
});
test("[constraint] unknown type exits 2 and lists valid types", async () => {
  const r = await sel(["--type", "bogus"]); expect(r.code).toBe(2); expect(r.err).toMatch(/attempt/); expect(r.err).toMatch(/confirmed_change/);
});
test("[constraint] --type without --selected exits 2 mentioning --selected", async () => {
  const p = await projectWithSession(); const r = await exec(["context", "--type", "attempt"], p.env, p.cwd);
  expect(r.code).toBe(2); expect(r.err).toMatch(/--selected/);
});
`,
  },
  {
    id: "H2",
    kind: "handoff",
    turns: [
      "I want `ccp --version --json` to print a JSON object with exactly three keys: version (the package version), compilerVersion and policyVersion. Plain `ccp --version` must keep printing just the version line as today. Your part is only the tests: write failing tests for this in test/version-json.test.ts, run them to show they fail, and stop. Don't implement it — someone else will pick up the implementation.",
    ],
    next: "continue this task",
    hiddenTest: `${HELPERS}
import { test, expect } from "vitest";
test("[core] --version --json prints the three keys", async () => {
  const r = await exec(["--version", "--json"], {}, process.cwd());
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(Object.keys(j).sort()).toEqual(["compilerVersion", "policyVersion", "version"]);
  expect(j.version).toBe("0.1.0");
  expect(j.compilerVersion).toMatch(/^context-compiler-v/);
  expect(j.policyVersion).toMatch(/^anthropic-opus-5\.5-policy-v/);
});
test("[constraint] plain --version is unchanged", async () => {
  expect((await exec(["--version"], {}, process.cwd())).out).toBe("0.1.0\\n");
});
`,
  },
  {
    id: "H3",
    kind: "interruption",
    turns: [
      "Add a CCP_EFFORT environment variable that overrides the configured effort for compilation. Precedence: the --effort flag beats CCP_EFFORT, which beats the config file. An invalid CCP_EFFORT value must exit with code 2 and an error that mentions CCP_EFFORT. For now only add the parsing/validation of the env var in the config layer with a test, and stop there. We'll wire it into compilation after the weekend.",
    ],
    next: "I'm back after the weekend — continue where we left off",
    hiddenTest: `${HELPERS}
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
const effortUsed = async (env, extra = []) => {
  const p = await projectWithSession(); const log = join(await tmp("hl-"), "args.json");
  const r = await exec([...extra, "--no-copy", "fix the login bug"], { ...p.env, ...env, CCP_FAKE_LOG: log }, p.cwd);
  let args = []; try { args = JSON.parse(readFileSync(log, "utf8")); } catch {}
  return { r, effort: args[args.indexOf("--effort") + 1] };
};
test("[core] CCP_EFFORT sets the compile effort", async () => {
  const { r, effort } = await effortUsed({ CCP_EFFORT: "low" }); expect(r.code).toBe(0); expect(effort).toBe("low");
});
test("[constraint] --effort beats CCP_EFFORT", async () => {
  expect((await effortUsed({ CCP_EFFORT: "low" }, ["--effort", "high"])).effort).toBe("high");
});
test("[constraint] invalid CCP_EFFORT exits 2 mentioning CCP_EFFORT", async () => {
  const { r } = await effortUsed({ CCP_EFFORT: "turbo" }); expect(r.code).toBe(2); expect(r.err).toMatch(/CCP_EFFORT/);
});
`,
  },
];

function claude(args: string[], cwd: string, input?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 900_000);
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, out })));
    child.stdin.end(input ?? "");
  });
}

const AGENT = ["--safe-mode", "--model", "claude-opus-5-5", "--effort", "medium", "--permission-mode", "dontAsk", "--tools", "Bash,Read,Edit,Write,Glob,Grep", "--allowedTools", ...AGENT_ALLOWED_TOOLS, "--max-budget-usd", "3"];

async function hidden(clone: string, s: Scenario): Promise<{ pass: boolean; failed: string[] }> {
  const f = join(clone, "test", "zz-hidden.test.ts");
  await writeFile(f, s.hiddenTest);
  const r = await run(join(clone, "node_modules", ".bin", "vitest"), ["run", "test/zz-hidden.test.ts", "--reporter=verbose"], { cwd: clone, timeoutMs: 300_000 });
  await rm(f, { force: true });
  const out = r.stdout + r.stderr;
  const failed = [...out.matchAll(/[×✗] .*?(\[(?:core|constraint)\][^\n]*?)(?: \d+ms)?$/gm)].map((m) => m[1]!.trim());
  return { pass: r.ok, failed };
}

async function snapshot(clone: string, label: string) {
  await run("git", ["-c", "user.email=b@b", "-c", "user.name=b", "add", "-A"], { cwd: clone });
  await run("git", ["-c", "user.email=b@b", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", label], { cwd: clone });
}
async function resetTo(clone: string, label: string) {
  const rev = (await run("git", ["log", "--format=%H", `--grep=^${label}$`, "-n", "1"], { cwd: clone })).stdout.trim();
  await run("git", ["reset", "-q", "--hard", rev], { cwd: clone });
  await run("git", ["clean", "-qfd", "-e", "node_modules"], { cwd: clone });
}

async function ccp(clone: string, flagName: "--recover" | "--handoff", instruction: string): Promise<{ brief: string; ms: number; err: string }> {
  const t0 = Date.now();
  const r = await run(process.execPath, [join(REPO, "dist", "cli", "index.js"), flagName, "--print", "--no-copy", instruction], { cwd: clone, timeoutMs: 180_000 });
  return { brief: r.stdout.trim(), ms: Date.now() - t0, err: r.stderr };
}

async function runScenario(s: Scenario) {
  const clone = join(WORK, s.id);
  await rm(clone, { recursive: true, force: true });
  await run("git", ["clone", "-q", REPO, clone], { timeoutMs: 120_000 });
  await symlink(join(REPO, "node_modules"), join(clone, "node_modules"));
  const log = (m: string) => appendFile(join(WORK, `${s.id}.log`), `${m}\n`);
  const start = await hidden(clone, s);
  await log(`hidden tests at start: ${start.pass ? "PASS (invalid scenario)" : `fail as expected (${start.failed.length} listed)`}`);

  const sessionId = randomUUID();
  for (let i = 0; i < s.turns.length; i++) {
    const args = i === 0 ? ["-p", "--session-id", sessionId, ...AGENT] : ["-p", "--resume", sessionId, ...AGENT];
    const r = await claude([...args, s.turns[i]!], clone);
    await log(`── Agent A turn ${i + 1} (exit ${r.code})\n${r.out.slice(-2500)}`);
  }
  if (s.kind === "compaction") {
    const r = await claude(["-p", "--resume", sessionId, "--safe-mode", "--tools", "", "--model", "claude-opus-5-5", "/compact"], clone);
    await log(`── /compact (exit ${r.code})`);
  }
  await snapshot(clone, "BENCH-ARM-START");
  const aState = await hidden(clone, s);
  await log(`hidden tests after Agent A: ${aState.pass ? "pass" : aState.failed.join("; ")}`);

  const results: Record<string, unknown> = { scenario: s.id, kind: s.kind, sessionId, agentAState: aState };
  for (const arm of ["without", "with"] as const) {
    await resetTo(clone, "BENCH-ARM-START");
    let message = s.next;
    if (arm === "with") {
      const c = await ccp(clone, s.kind === "handoff" || process.argv.includes("--p9") ? "--handoff" : "--recover", s.next);
      results.brief = c.brief;
      results.briefMs = c.ms;
      await log(`── ccp brief (${c.ms} ms)\n${c.brief}\n${c.err.slice(-600)}`);
      message = c.brief;
    }
    const t0 = Date.now();
    const args = s.kind === "compaction" ? ["-p", "--resume", sessionId, "--fork-session", "--no-session-persistence", ...AGENT] : ["-p", "--no-session-persistence", ...AGENT];
    const r = await claude([...args, "--output-format", "json", message], clone);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(r.out.slice(r.out.indexOf("{"))) as Record<string, unknown>;
    } catch {
      // keep empty
    }
    const v = await hidden(clone, s);
    results[arm] = { pass: v.pass, failed: v.failed, turns: meta.num_turns, seconds: Math.round((Date.now() - t0) / 1000), costUsd: meta.total_cost_usd, finalText: String(meta.result ?? r.out).slice(0, 1500) };
    await log(`── arm ${arm}: ${v.pass ? "PASS" : `FAIL ${v.failed.join("; ")}`} (${Math.round((Date.now() - t0) / 1000)} s)\n${String(meta.result ?? "").slice(0, 1200)}`);
  }
  await appendFile(join(WORK, "real-results.jsonl"), JSON.stringify(results) + "\n");
  process.stderr.write(`${s.id}: without ccp ${(results.without as { pass: boolean }).pass ? "PASS" : "FAIL"}, with ccp ${(results.with as { pass: boolean }).pass ? "PASS" : "FAIL"}\n`);
}

async function main() {
  await mkdir(WORK, { recursive: true });
  if (process.argv.includes("--cleanup")) {
    for (const s of [...SCENARIOS, ...P9_SCENARIOS]) {
      await rm(join(homedir(), ".claude", "projects", projectSlug(join(WORK, s.id))), { recursive: true, force: true });
      await rm(join(WORK, s.id), { recursive: true, force: true });
    }
    console.log("cleaned up");
    return;
  }
  const set = process.argv.includes("--p9") ? P9_SCENARIOS : SCENARIOS;
  for (const s of set.filter((x) => !arg("--scenario") || x.id === arg("--scenario"))) await runScenario(s);
  void readFile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
