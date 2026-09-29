import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeJsonlAdapter } from "../src/context/adapters/claude-code-jsonl.js";
import { analyzeSession } from "../src/context/analysis/session.js";
import type { SessionLocation } from "../src/context/claude-session.js";
import type { ContextLimits, SessionContext } from "../src/context/snapshot.js";
import { TranscriptBuilder } from "./fixtures/transcript-builder.js";
import { tempDir } from "./helpers.js";

const LIMITS: ContextLimits = {
  maxSessionTurns: 20, maxPromptChars: 2000, maxResponseChars: 600, maxToolOutputChars: 800,
  maxDiffBytes: 8000, maxInstructionFileBytes: 16000, maxListedFiles: 50,
};
const LOC: SessionLocation = { method: "explicit", sessionId: "s", transcriptPath: "/t.jsonl", live: null, alternatives: [], notes: [] };
const APP = "/work/demo-app";

async function analyze(b: TranscriptBuilder, limits = LIMITS) {
  const path = await b.save(join(await tempDir(), "s.jsonl"));
  const snap = await new ClaudeCodeJsonlAdapter().read(path, { maxPromptChars: 2000, maxResponseChars: 600, maxToolOutputChars: 800 });
  const ctx = analyzeSession(snap, limits, LOC);
  if (ctx.status !== "loaded") throw new Error("not loaded");
  return ctx as Extract<SessionContext, { status: "loaded" }>;
}

describe("files touched", () => {
  it("confirms successful Edit/Write calls and ignores failed edits", async () => {
    const ctx = await analyze(
      new TranscriptBuilder().user("fix it").read(`${APP}/src/a.ts`).edit(`${APP}/src/a.ts`).write(`${APP}/src/b.ts`).edit(`${APP}/src/c.ts`, "String to replace not found"),
    );
    expect(ctx.files.confirmedChanges.map((c) => c.path)).toEqual([`${APP}/src/a.ts`, `${APP}/src/b.ts`]);
    expect(ctx.files.observed.map((o) => o.path)).toEqual([`${APP}/src/a.ts`]);
    expect(ctx.failures).toContainEqual(expect.objectContaining({ kind: "tool_error", certainty: "confirmed" }));
  });

  it("labels shell-written files as inferred and keeps them out of confirmed changes", async () => {
    const ctx = await analyze(
      new TranscriptBuilder().user("create config").bash("cat > src/config.ts <<'EOF'\nexport const a = 1 > 0;\nEOF").bash(`sed -i '' 's/a/b/' ${APP}/src/x.ts`).bash("rm old.ts"),
    );
    expect(ctx.files.confirmedChanges).toEqual([]);
    expect(ctx.files.inferredChanges.map((i) => [i.path, i.operation, i.via, i.certainty])).toEqual([
      [`${APP}/src/config.ts`, "write", "redirect", "inferred"],
      [`${APP}/src/x.ts`, "write", "sed -i", "inferred"],
      [`${APP}/old.ts`, "delete", "rm", "inferred"],
    ]);
    expect(ctx.unknowns.join()).toContain("inferred from shell commands");
  });

  it("does not infer a file that also has a confirmed change", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("x").write(`${APP}/a.ts`).bash(`echo hi >> ${APP}/a.ts`));
    expect(ctx.files.inferredChanges).toEqual([]);
  });
});

describe("failure signals", () => {
  it("classifies a non-zero command exit", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("build").bash("npm run build", { exit: 2, stderr: "error TS2345" }));
    expect(ctx.failures).toEqual([
      expect.objectContaining({ kind: "nonzero_exit", certainty: "confirmed", source: expect.objectContaining({ exitCode: 2, command: "npm run build" }) }),
    ]);
  });

  it("classifies a failing test command as a test failure", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("test").bash("npx vitest run auth", { exit: 1, stdout: "FAIL auth.test.ts > signup" }));
    expect(ctx.failures[0]).toMatchObject({ kind: "test_failure", certainty: "confirmed", evidence: expect.stringContaining("auth.test.ts") });
  });

  it("captures an explicit user-reported failure from authored text only", async () => {
    const ctx = await analyze(
      new TranscriptBuilder().user("fix login").user("that didn't fix it, still getting a 401").pasted("look at this log", "request failed; the fix did not work"),
    );
    const reported = ctx.failures.filter((f) => f.kind === "user_reported");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ turn: 2, certainty: "reported", evidence: expect.stringContaining("didn't fix") });
  });

  it("marks ambiguous signals as uncertain", async () => {
    const ctx = await analyze(
      new TranscriptBuilder()
        .user("look")
        .bash("grep -rn authToken src", { exit: 1 })
        .bash("npm test", { stdout: "Tests: 2 failed, 10 passed" }),
    );
    expect(ctx.failures.map((f) => [f.kind, f.certainty])).toEqual([
      ["possible_failure", "uncertain"],
      ["possible_failure", "uncertain"],
    ]);
  });

  it("records Claude's own problem reports as reported, not confirmed", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("go").say("The signup test is still failing after this change."));
    expect(ctx.failures[0]).toMatchObject({ kind: "assistant_reported", certainty: "reported" });
  });

  it("records interruptions as confirmed events with uncertain meaning", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("go").bash("npm run e2e", { interrupted: true, stdout: "" }));
    expect(ctx.failures[0]).toMatchObject({ kind: "interrupted", certainty: "confirmed", note: expect.stringContaining("unknown") });
  });
});

describe("attempts", () => {
  const twoAttempts = () =>
    new TranscriptBuilder()
      .user("signup attribution is broken")
      .read(`${APP}/src/auth/callback.ts`)
      .edit(`${APP}/src/auth/callback.ts`)
      .bash("npm test -- auth", { exit: 1, stdout: "FAIL src/auth/auth.test.ts\n  registration_completed attribution missing" })
      .say("Changed callback handling; the auth test still fails.")
      .user("still failing. try the attribution init instead")
      .edit(`${APP}/src/analytics/attribution.ts`)
      .bash("npm test -- auth", { stdout: "Tests: 12 passed" })
      .say("Attribution now initialises before registration_completed fires. Tests pass.")
      .user("ok, now update the README")
      .bash("echo '## Attribution' >> README.md");

  it("builds one attempt per turn that changed files, with evidence-based outcomes", async () => {
    const ctx = await analyze(twoAttempts());
    expect(ctx.attempts.map((a) => [a.turn, a.outcome])).toEqual([
      [1, "reported_failure"],
      [2, "verified_success"],
      [3, "unverified"],
    ]);
    const [first, second, third] = ctx.attempts;
    expect(first!.changes).toEqual({ confirmed: [`${APP}/src/auth/callback.ts`], inferred: [] });
    expect(first!.verification).toMatchObject({ command: "npm test -- auth", status: "error", exitCode: 1 });
    expect(first!.evidence.map((e) => [e.kind, e.certainty])).toEqual(
      expect.arrayContaining([["test_failure", "confirmed"], ["user_reported", "reported"], ["assistant_reported", "reported"]]),
    );
    expect(second!.verification).toMatchObject({ status: "ok" });
    expect(third!.changes).toEqual({ confirmed: [], inferred: [`${APP}/README.md`] });
    expect(ctx.unknowns.join()).toContain("turn 3");
  });

  it("uses a confirmed failure when the user said nothing", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("fix").edit(`${APP}/a.ts`).bash("npm test", { exit: 1, stdout: "FAIL" }));
    expect(ctx.attempts[0]!.outcome).toBe("confirmed_failure");
  });

  it("ignores verification that ran before the change", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("fix").bash("npm test", { stdout: "ok" }).edit(`${APP}/a.ts`));
    expect(ctx.attempts[0]).toMatchObject({ verification: null, outcome: "unverified" });
  });

  it("does not create attempts for investigation-only turns", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("where is auth handled?").read(`${APP}/src/auth.ts`).say("In src/auth.ts."));
    expect(ctx.attempts).toEqual([]);
  });

  it("only includes turns inside the window", async () => {
    const ctx = await analyze(twoAttempts(), { ...LIMITS, maxSessionTurns: 1 });
    expect(ctx.window).toEqual({ turns: 1, fromTurn: 3, toTurn: 3 });
    expect(ctx.attempts.map((a) => a.turn)).toEqual([3]);
    expect(ctx.task.recentPrompts.map((p) => p.turn)).toEqual([3]);
  });
});

describe("compaction and pending work", () => {
  it("flags compacted history and pending tool calls as unknowns", async () => {
    const ctx = await analyze(new TranscriptBuilder().user("a").compact().user("b").bash("npm run dev", { noResult: true }));
    expect(ctx.compactions).toHaveLength(1);
    expect(ctx.task.toolCallStates.unknown).toBe(1);
    expect(ctx.unknowns.join("\n")).toMatch(/compacted[\s\S]*no recorded result/);
  });
});

describe("pasted-only prompts", () => {
  it("labels an attempt started by pasted text as pasted", async () => {
    const ctx = await analyze(new TranscriptBuilder().pasted("", "Spec: add a login page").write(`${APP}/login.ts`));
    expect(ctx.attempts[0]!.request).toBe("[pasted] Spec: add a login page");
  });
});
