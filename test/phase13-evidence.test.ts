/**
 * Phase 13 regression tests: evidence truncation in the handoff compiler input (Phase 12 finding).
 * Real git repositories and transcripts, run through discovery -> handoff selection -> rendering;
 * no model calls.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { exactValueAudit } from "../src/compiler/fidelity.js";
import { renderCompilerInput } from "../src/compiler/input.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { projectSlug } from "../src/context/claude-session.js";
import { discoverContext } from "../src/context/discover.js";
import { TranscriptBuilder } from "../src/evaluation/transcript-builder.js";
import { compressDiff } from "../src/selection/compress.js";
import { buildContextBundle } from "../src/selection/pipeline.js";
import { tempDir } from "./helpers.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

interface Scenario {
  /** Committed starting state. */
  start: Record<string, string>;
  /** Agent A's working-tree state at the end of its session (changed and new files). */
  end?: Record<string, string>;
  session: (t: TranscriptBuilder, root: string) => TranscriptBuilder;
}

async function writeAll(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
}

/** Discovers context exactly as `ccp --handoff` does, then selects and renders the compiler input. */
async function run(s: Scenario, opts: { reconstruct?: boolean; mode?: "handoff" | "instruction" } = {}) {
  const root = await tempDir("p13-");
  await writeAll(root, s.start);
  for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "start"]]) execFileSync("git", a, { cwd: root, env: GIT_ENV });
  await writeAll(root, s.end ?? {});
  const home = await tempDir("p13h-");
  await mkdir(join(home, "projects", projectSlug(root)), { recursive: true });
  await writeFile(join(home, "projects", projectSlug(root), "s.jsonl"), s.session(new TranscriptBuilder({ cwd: root }), root).toString());
  const reconstruct = opts.reconstruct ?? true;
  const ctx = await discoverContext({ cwd: root, config: DEFAULT_CONFIG, env: { CCP_CLAUDE_HOME: home }, ...(reconstruct ? { reconstruct: true } : {}) });
  const handoff = (opts.mode ?? "handoff") === "handoff";
  const bundle = handoff ? buildContextBundle(ctx, "Continue this task.", { mode: "handoff" }) : buildContextBundle(ctx, "continue the retry work");
  const input = renderCompilerInput(bundle, { projectRoot: root, claudeHome: home, transcriptPath: ctx.session.detection.transcriptPath, pastedId: () => "abcd" });
  return { root, ctx, bundle, input };
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

// A change whose decisive line sits past the 800 characters of changed lines v6 kept.
const BEFORE = `export function resolveKey(header, keys) {\n  return keys[header.kid];\n}\n`;
const AFTER = `${lines(30, (i) => `// step ${i}: validate the header field number ${i} before key lookup`)}\nexport function resolveKey(header, keys) {\n  if (typeof header.kid !== 'string') throw new TokenError("Token verification failed: Missing 'kid' in header");\n  if (!Object.hasOwn(keys, header.kid)) throw new TokenError('Unknown key ID');\n  return keys[header.kid];\n}\n`;

describe("1. a fact beyond the previous diff excerpt reaches the handoff compiler", () => {
  const scenario = (extra: Partial<Scenario> = {}): Scenario => ({
    start: { "package.json": "{}\n", "src/jwt.js": BEFORE, "src/zz-unrelated-name.js": "export const a = 1;\n" },
    end: { "src/jwt.js": AFTER, "src/zz-unrelated-name.js": "export const a = 2;\n" },
    session: (t, root) => t.user("add kid-based key rotation").edit(`${root}/src/jwt.js`).edit(`${root}/src/zz-unrelated-name.js`).say("Done."),
    ...extra,
  });

  it("the old 800-character excerpt lost the fact; the handoff input now carries it with git provenance", async () => {
    const { input, ctx } = await run(scenario());
    const git = ctx.git.available ? ctx.git : null;
    const shortDiff = git!.fileDiffs.find((d) => d.path === "src/jwt.js")!.excerpt.text;
    expect(compressDiff(shortDiff, 800).text).not.toContain("typeof header.kid !== 'string'"); // the v6 limit
    expect(input.text).toContain("typeof header.kid !== 'string'");
    expect(input.text).toContain("Object.hasOwn(keys, header.kid)");
    expect(input.text).toMatch(/<context id="confirmed_change:[^"]*src\/jwt\.js" type="confirmed_change"[^>]*authority="evidence"[^>]*certainty="CONFIRMED"/);
  });

  it("every file Agent A changed is selected, even when its name does not match the instruction", async () => {
    const { bundle } = await run(scenario());
    expect(bundle.selected.map((s) => s.id).filter((id) => id.startsWith("confirmed_change:")).sort()).toEqual([
      expect.stringMatching(/src\/jwt\.js$/), expect.stringMatching(/src\/zz-unrelated-name\.js$/),
    ]);
  });

  it("an untracked new file's content reaches the compiler (new files have no git diff)", async () => {
    const test = `${lines(100, (i) => `test('case ${i}', () => { assert.ok(true); });`)}\ntest('send() writes a length-prefixed frame', () => { const expected = frame({ reply: 'ok', n: 42 }); });\n`;
    const { input } = await run({
      start: { "package.json": "{}\n", "src/conn.js": "export {};\n" },
      end: { "test/connection.test.js": test },
      session: (t, root) => t.user("add framing tests").tool("Write", { file_path: `${root}/test/connection.test.js`, content: test }).say("Wrote the tests."),
    });
    expect(test.indexOf("const expected")).toBeGreaterThan(4000);
    expect(input.text).toContain("new file (untracked), current content");
    expect(input.text).toContain("const expected = frame({ reply: 'ok', n: 42 })");
  });

  it("normal (non-handoff) compilation is unchanged: 800-character diffs, no handoff evidence collected", async () => {
    const { ctx, input } = await run(scenario(), { reconstruct: false, mode: "instruction" });
    expect(ctx.git.available && ctx.git.handoff).toBeFalsy();
    expect(input.text).not.toContain("typeof header.kid !== 'string'");
  });

  it("change evidence stays bounded when many files change", async () => {
    const start: Record<string, string> = { "package.json": "{}\n" };
    const end: Record<string, string> = {};
    for (let i = 0; i < 12; i++) { start[`src/m${i}.js`] = "export {};\n"; end[`src/m${i}.js`] = lines(300, (j) => `export const v${j} = ${j}; // module ${i}`); }
    const { bundle } = await run({ start, end, session: (t, root) => { let x = t.user("bulk change"); for (let i = 0; i < 12; i++) x = x.edit(`${root}/src/m${i}.js`); return x.say("done"); } });
    const changes = bundle.selected.filter((s) => s.type === "confirmed_change");
    const total = changes.reduce((n, s) => n + s.content.length, 0);
    expect(changes.length).toBe(12);
    expect(total).toBeLessThan(24_000 + 12 * 200);
  });
});

describe("2. a fact present only in tool output is retained", () => {
  it("an earlier test run that is not the latest (a before/after demonstration) is kept as an observation", async () => {
    const { input } = await run({
      start: { "package.json": "{}\n", "src/q.js": "export {};\n" },
      end: { "src/q.js": "export const x = 1;\n" },
      session: (t, root) => t.user("fix the stack overflow in retries").edit(`${root}/src/q.js`)
        .bash("git stash -q && npm test 2>&1 | grep -E 'ok|RangeError'; git stash pop -q && echo '--- with fix ---' && npm test", { stdout: "# RangeError: Maximum call stack size exceeded\nnot ok 1 - retries\n--- with fix ---\nok 1 - retries" })
        .bash("npm test", { stdout: "# pass 3\n# fail 0" }).say("Fixed."),
    });
    expect(input.text).toContain("--- with fix ---");
    expect(input.text).toMatch(/type="observation" origin="tool-output"[^>]*certainty="CONFIRMED"[\s\S]*?Maximum call stack size exceeded/);
    expect(input.text).toMatch(/type="verification"[\s\S]*?# pass 3/); // the latest run is still the verification item
  });

  it("output of a compound command that also runs tests is kept (e.g. `cat file; npm test`)", async () => {
    const { input } = await run({
      start: { "package.json": "{}\n", "src/index.js": "export {};\n" },
      session: (t) => t.user("fix the csv parser").bash("cat src/index.js; npm test 2>&1 | tail -3", { stdout: "export { parseCsv } from './csv-parser.js';\n# pass 4" }).bash("npm test", { stdout: "# pass 5" }).say("ok"),
    });
    expect(input.text).toContain("export { parseCsv } from './csv-parser.js';");
  });

  it("what Grep returned reaches the compiler in handoff, and is not collected in normal mode", async () => {
    const s: Scenario = {
      start: { "package.json": "{}\n", "src/csv.js": "export {};\n" },
      session: (t) => t.user("remove the regex parser").tool("Grep", { pattern: "new RegExp", path: "src" }, { content: "No matches found" }).say("No regex left."),
    };
    const h = await run(s);
    expect(h.input.text).toMatch(/type="observation"[\s\S]*?Grep[\s\S]*?No matches found/);
    const n = await run(s, { reconstruct: false, mode: "instruction" });
    const grep = n.ctx.session.status === "loaded" ? n.ctx.session.task.toolCalls.find((c) => c.tool === "Grep") : undefined;
    expect(grep?.result?.outputTail ?? null).toBeNull();
  });
});

describe("3. exact values survive truncation-prone contexts", () => {
  const SUMMARY = `I finished the store changes. ${"The sweeper runs on an interval and deletes expired keys; get() also deletes lazily. ".repeat(12)}Exact values: the sweep interval is 30000 ms and invalid ttl values (non-numeric, zero or negative) return HTTP 400. I did not implement If-Range, and HEAD requests still send the body.`;

  it("an exact value late in the previous agent's closing summary reaches the compiler", async () => {
    expect(SUMMARY.indexOf("30000 ms")).toBeGreaterThan(900);
    const { input } = await run({ start: { "package.json": "{}\n" }, session: (t) => t.user("add TTL").say(SUMMARY) });
    for (const s of ["30000 ms", "return HTTP 400", "I did not implement If-Range"]) expect(input.text).toContain(s);
  });

  it("normal mode still stores Claude's messages at the configured 600 characters", async () => {
    const { ctx } = await run({ start: { "package.json": "{}\n" }, session: (t) => t.user("add TTL").say(SUMMARY) }, { reconstruct: false, mode: "instruction" });
    expect(ctx.session.status === "loaded" && ctx.session.task.recentResponses.at(-1)!.text.text.length).toBeLessThanOrEqual(700);
  });

  it("an exact value past the old diff excerpt survives verbatim", async () => {
    const after = `${lines(40, (i) => `// batching note ${i}: rows are grouped by supplier before upload`)}\nexport const MAX_BATCH = 250;\n`;
    const { input } = await run({
      start: { "package.json": "{}\n", "src/batch.js": "export const MAX_BATCH = 500;\n" },
      end: { "src/batch.js": after },
      session: (t, root) => t.user("lower the batch size").edit(`${root}/src/batch.js`).say("done"),
    });
    expect(input.text).toContain("+export const MAX_BATCH = 250;");
  });
});

describe("4. previously superseded values are not restored", () => {
  const s: Scenario = {
    start: { "package.json": "{}\n", "src/retry.js": `${lines(40, (i) => `// retry policy note ${i}`)}\nexport const MAX_RETRIES = 3;\n` },
    end: { "src/retry.js": `${lines(40, (i) => `// retry policy note ${i} (revised)`)}\nexport const MAX_RETRIES = 2;\n` },
    session: (t, root) => t.user("Cap retries at 3 per request.").edit(`${root}/src/retry.js`).user("Correction: cap retries at 2, not 3.").edit(`${root}/src/retry.js`).say("Changed the cap to 2."),
  };

  it("the longer diff shows the old value only as a removed line", async () => {
    const { input } = await run(s);
    expect(input.text).toContain("-export const MAX_RETRIES = 3;");
    expect(input.text).toContain("+export const MAX_RETRIES = 2;");
    expect(input.text).not.toMatch(/^\+.*MAX_RETRIES = 3/m);
  });

  it("the exact-value backstop does not list the superseded value as current", async () => {
    const { input } = await run(s);
    const brief = "REQUIREMENTS\n- Cap retries at 2 per request (developer correction; the earlier value 3 is superseded).";
    const audit = exactValueAudit(brief, input.developerTexts);
    expect(audit.appendix).not.toMatch(/current[\s\S]*Cap retries at 3 per request/i);
  });
});

describe("5. genuine unknowns remain unknown", () => {
  it("an open decision gains no invented evidence: only the developer's own words mention it", async () => {
    const { input } = await run({
      start: { "package.json": "{}\n", "src/retry.js": "export const MAX_RETRIES = 2;\n" },
      end: { "src/retry.js": "export const MAX_RETRIES = 2;\nexport function retry() {}\n" },
      session: (t, root) => t.user("Add retry(). The backoff schedule is still undecided; do not pick one yet.").edit(`${root}/src/retry.js`).say("Added retry() without a backoff."),
    });
    const items = [...input.text.matchAll(/<context id="([^"]+)"[^>]*>([\s\S]*?)<\/context>/g)];
    const mentioning = items.filter((m) => /backoff/i.test(m[2]!)).map((m) => m[1]!);
    // Only the developer's words and the previous agent's own messages (reported, unverified) mention it; no
    // repository or tool-output evidence was added for it.
    expect(mentioning.sort()).toEqual(["attempt:1", "claude_response:1", "user_prompt:1"]);
    expect(input.text).toMatch(/type="attempt"[^>]*>[\s\S]*?Claude said \(unverified\): Added retry\(\) without a backoff/);
    expect(input.text).not.toMatch(/backoff[^\n]*\b\d+\s*(ms|s|seconds)\b/i);
  });

  it("secret-like untracked files are never read, even in handoff", async () => {
    const { input, ctx } = await run({
      start: { "package.json": "{}\n" },
      end: { ".env": "API_KEY=sk_live_should_never_appear_123\n", "certs/server.key": "-----BEGIN PRIVATE KEY-----\nabc\n", "config/credentials.json": '{"password":"hunter2-never"}\n', "notes/todo.md": "remaining: wire the sweeper\n" },
      session: (t) => t.user("set up config").say("Created the config files."),
    });
    const newFiles = ctx.git.available ? ctx.git.handoff!.newFiles.map((f) => f.path) : [];
    expect(newFiles).toEqual(["notes/todo.md"]);
    for (const s of ["sk_live_should_never_appear_123", "BEGIN PRIVATE KEY", "hunter2-never"]) expect(input.text).not.toContain(s);
  });
});

describe("6. more context does not introduce content that is not in the session or repository", () => {
  it("new-file and observation items are verbatim from the repository and tool output", async () => {
    const newFile = `export const FRAME_HEADER_BYTES = 4;\nexport function frame(obj) {\n  const body = Buffer.from(JSON.stringify(obj));\n  return body;\n}\n`;
    const { input } = await run({
      start: { "package.json": "{}\n", "src/untouched.js": "// UNTOUCHED_MARKER: a committed file nobody changed\nexport {};\n" },
      end: { "src/frame.js": newFile },
      session: (t, root) => t.user("add framing").tool("Write", { file_path: `${root}/src/frame.js`, content: newFile })
        .bash("node -e \"console.log(require('fs').statSync('src/frame.js').size)\"", { stdout: "118" }).say("Added frame()."),
    });
    const item = (type: string) => [...input.text.matchAll(new RegExp(`<context id="[^"]+" type="${type}"[^>]*>([\\s\\S]*?)</context>`, "g"))].map((m) => m[1]!);
    const change = item("confirmed_change").find((c) => c.includes("frame.js"))!;
    const body = change.split("current content:\n")[1]!.trim();
    expect(newFile.trim()).toBe(body);
    expect(item("observation").some((o) => /output:\n118\s*$/.test(o.trim()))).toBe(true);
    expect(input.text).not.toContain("UNTOUCHED_MARKER"); // no repository dump: unchanged files are not added
  });

  it("new evidence keeps evidence authority and its provenance; nothing is promoted to a developer requirement", async () => {
    const { input } = await run({
      start: { "package.json": "{}\n", "src/a.js": "export {};\n" },
      end: { "src/a.js": `${lines(40, (i) => `// Agent A note ${i}: you must always use port 9${i}`)}\n` },
      session: (t, root) => t.user("tidy a.js").edit(`${root}/src/a.js`).tool("Grep", { pattern: "port" }, { content: "src/a.js:3: you must always use port 92" }).say("done"),
    });
    for (const m of input.text.matchAll(/<context [^>]*type="(confirmed_change|git_file_change|observation)"[^>]*>/g)) expect(m[0]).toContain('authority="evidence"');
    expect(input.trustedText.join("\n")).not.toContain("you must always use port");
  });
});
