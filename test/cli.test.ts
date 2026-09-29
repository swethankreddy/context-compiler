import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Clipboard } from "../src/clipboard/clipboard.js";
import { run } from "../src/cli/run.js";
import { fakeClaudeBin, makeClaudeHome, tempDir } from "./helpers.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

async function setup(opts: { clipboardFails?: boolean } = {}) {
  const cwd = await tempDir("ccp-project-");
  const home = await makeClaudeHome(cwd, [{ sessionId: SESSION, fixture: "auth-session.jsonl" }]);
  const env = { CCP_CLAUDE_HOME: home, CCP_CONFIG_DIR: await tempDir(), CCP_CLAUDE_BIN: await fakeClaudeBin() };
  const copied: string[] = [];
  const clipboard: Clipboard = {
    name: "fake",
    copy: async (t) => {
      if (opts.clipboardFails) throw new Error("no clipboard");
      copied.push(t);
    },
  };
  const exec = async (argv: string[], stdin = "") => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    let out = "", err = "";
    stdout.on("data", (d) => (out += d));
    stderr.on("data", (d) => (err += d));
    const code = await run(argv, { stdin: Readable.from([stdin]), stdout, stderr, env, cwd, clipboard });
    return { code, out, err };
  };
  return { exec, copied };
}

describe("ccp", () => {
  it("compiles and copies to the clipboard by default", async () => {
    const { exec, copied } = await setup();
    const r = await exec(["fix the auth issue"]);
    expect(r.code).toBe(0);
    expect(copied).toEqual(["COMPILED: fix the auth issue"]);
    expect(r.err).toContain("Session loaded");
    expect(r.err).toContain("Copied to clipboard");
  });

  it("--print writes only the instruction to stdout", async () => {
    const { exec, copied } = await setup();
    const r = await exec(["--print", "--no-copy", "run", "the", "tests"]);
    expect(r).toMatchObject({ code: 0, out: "COMPILED: run the tests\n", err: "" });
    expect(copied).toEqual([]);
  });

  it("--no-copy prints the instruction instead of copying", async () => {
    const { exec, copied } = await setup();
    const r = await exec(["--no-copy", "fix this"]);
    expect(r.out).toBe("COMPILED: fix this\n");
    expect(copied).toEqual([]);
  });

  it("--preview shows context and instruction without copying", async () => {
    const { exec, copied } = await setup();
    const r = await exec(["--preview", "fix the auth issue"]);
    expect(r.out).toContain('TASK  "fix the auth issue"');
    expect(r.out).toContain("SELECTED");
    expect(r.out).toContain("COMPILED (context_enriched");
    expect(r.out).toContain("COMPILED: fix the auth issue");
    expect(copied).toEqual([]);
  });

  it("reads the instruction from stdin when no argument is given", async () => {
    const { exec, copied } = await setup();
    const r = await exec([], "fix the login bug\n");
    expect(r.code).toBe(0);
    expect(copied).toEqual(["COMPILED: fix the login bug"]);
  });

  it("rejects an empty instruction", async () => {
    const { exec } = await setup();
    expect((await exec([], "  ")).code).toBe(2);
  });

  it("falls back to printing when the clipboard fails", async () => {
    const { exec } = await setup({ clipboardFails: true });
    const r = await exec(["fix this"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("COMPILED: fix this\n");
    expect(r.err).toContain("could not copy");
  });

  it("context reports project, Claude Code version, session and eligibility", async () => {
    const { exec } = await setup();
    const r = await exec(["context"]);
    expect(r.code).toBe(0);
    for (const section of ["PROJECT", "GIT", "CLAUDE SESSION", "CURRENT INSTRUCTION", "RECENT TASK HISTORY", "FILES TOUCHED", "PREVIOUS ATTEMPTS / FAILURES", "PROJECT INSTRUCTIONS", "WARNINGS / UNKNOWNS"]) {
      expect(r.out).toContain(`\n${section}\n`);
    }
    expect(r.out).toContain("Claude Code 2.1.283");
    expect(r.out).toContain(`recent-transcript → ${SESSION}`);
    expect(r.out).toContain("Fix signup attribution");
    expect(r.out).toContain("unavailable (not-a-repository)");
    expect(r.out).toContain("analytics/attribution.ts");
    expect(r.out).toContain("Nothing has been sent to a model.");
  });

  it("context --json emits machine-readable output", async () => {
    const { exec } = await setup();
    const r = await exec(["context", "--json"]);
    const ctx = JSON.parse(r.out);
    expect(ctx.schemaVersion).toBe(1);
    expect(ctx.session.status).toBe("loaded");
    expect(ctx.session.detection.sessionId).toBe(SESSION);
    expect(ctx.session.metadata.claudeCodeVersions).toEqual(["2.1.283"]);
    expect(ctx.git).toEqual({ available: false, reason: "not-a-repository" });
    expect(ctx.limits.maxSessionTurns).toBe(20);
    expect(Object.keys(ctx.sizes)).toContain("session_prompts");
    expect(ctx.provenance.filesRead).toContain(ctx.session.detection.transcriptPath);
  });

  it("rejects unknown flags", async () => {
    const { exec } = await setup();
    expect((await exec(["--bogus"])).code).toBe(2);
  });
});

describe("ccp context in a git repository", () => {
  it("reports git state, instruction files and multiple live sessions", async () => {
    const { run: exec } = await import("../src/util/exec.js");
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { registerLiveSession } = await import("./helpers.js");
    const cwd = await tempDir("ccp-repo-");
    const git = (...a: string[]) => exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
    await git("init", "-q", "-b", "feature/login");
    await writeFile(join(cwd, "CLAUDE.md"), "# Rules\nRun npm test before finishing.");
    await writeFile(join(cwd, "AGENTS.md"), "agents");
    await git("add", ".");
    await git("commit", "-q", "-m", "init");
    await writeFile(join(cwd, "CLAUDE.md"), "# Rules\nchanged");
    await writeFile(join(cwd, "new.ts"), "x");

    const OTHER = "22222222-2222-2222-2222-222222222222";
    const home = await makeClaudeHome(cwd, [
      { sessionId: SESSION, fixture: "auth-session.jsonl" },
      { sessionId: OTHER, fixture: "auth-session.jsonl" },
    ]);
    await registerLiveSession(home, { pid: process.pid, sessionId: SESSION, cwd, updatedAt: 20 });
    await registerLiveSession(home, { pid: process.ppid, sessionId: OTHER, cwd, updatedAt: 10 });

    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (d) => (out += d));
    const code = await run(["context", "--json"], {
      stdin: Readable.from([""]), stdout, stderr: new PassThrough(), cwd,
      env: { CCP_CLAUDE_HOME: home, CCP_CONFIG_DIR: await tempDir(), CCP_CLAUDE_BIN: await fakeClaudeBin() },
    });
    expect(code).toBe(0);
    const ctx = JSON.parse(out);
    expect(ctx.git).toMatchObject({ available: true, branch: "feature/login", clean: false, unstaged: [{ path: "CLAUDE.md", status: "M" }], untracked: ["new.ts"] });
    expect(ctx.git.diff.included).toBe(true);
    expect(ctx.instructions.map((f: { path: string }) => f.path)).toEqual(["CLAUDE.md", "AGENTS.md"]);
    expect(ctx.session.detection).toMatchObject({ method: "live-session", sessionId: SESSION });
    expect(ctx.session.detection.alternatives.map((a: { sessionId: string }) => a.sessionId)).toEqual([OTHER]);
    expect(ctx.warnings.join()).toContain("--session");
  });
});
