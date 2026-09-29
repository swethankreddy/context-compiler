import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeJsonlAdapter, splitPasted } from "../src/context/adapters/claude-code-jsonl.js";
import type { ReadOptions } from "../src/context/adapters/types.js";
import { TranscriptBuilder } from "./fixtures/transcript-builder.js";
import { FIXTURES, tempDir } from "./helpers.js";

const adapter = new ClaudeCodeJsonlAdapter();
const OPTS: ReadOptions = { maxPromptChars: 2000, maxResponseChars: 600, maxToolOutputChars: 800 };

async function parse(b: TranscriptBuilder) {
  return adapter.read(await b.save(join(await tempDir(), "s.jsonl")), OPTS);
}

describe("ClaudeCodeJsonlAdapter", () => {
  it("extracts session metadata from the static fixture", async () => {
    const snap = await adapter.read(join(FIXTURES, "transcripts", "auth-session.jsonl"), OPTS);
    expect(snap.metadata).toMatchObject({
      sessionId: "11111111-2222-3333-4444-555555555555",
      title: "Fix signup attribution",
      cwd: "/work/demo-app",
      gitBranch: "fix/auth",
      claudeCodeVersions: ["2.1.283"],
      currentModel: "claude-opus-5-5",
      currentEffort: "medium",
      turnCount: 2,
      toolCallCount: 4,
      toolErrorCount: 1,
      compactionCount: 1,
    });
  });

  it("numbers turns and attaches tool results to their calls", async () => {
    const snap = await parse(
      new TranscriptBuilder().user("first").read("/work/demo-app/a.ts").user("second").bash("npm test", { exit: 1, stdout: "FAIL a.test.ts" }),
    );
    expect(snap.prompts.map((p) => [p.turn, p.text.text])).toEqual([[1, "first"], [2, "second"]]);
    const [read, bash] = snap.toolCalls;
    expect(read).toMatchObject({ turn: 1, tool: "Read", filePath: "/work/demo-app/a.ts", result: { status: "ok" } });
    expect(bash).toMatchObject({ turn: 2, command: "npm test", result: { status: "error", exitCode: 1 } });
    expect(bash!.result!.errorText!.text).toContain("FAIL a.test.ts");
  });

  it("keeps the output tail for successful commands and strips tool_use_error tags", async () => {
    const snap = await parse(new TranscriptBuilder().user("go").bash("ls", { stdout: "a\nb" }).edit("/x.ts", "String to replace not found"));
    expect(snap.toolCalls[0]!.result).toMatchObject({ status: "ok", outputTail: { text: "a\nb" } });
    expect(snap.toolCalls[1]!.result).toMatchObject({ status: "error", exitCode: null, errorText: { text: "String to replace not found" } });
  });

  it("records a missing result as null (pending)", async () => {
    const snap = await parse(new TranscriptBuilder().user("go").bash("npm run dev", { noResult: true }));
    expect(snap.toolCalls[0]!.result).toBeNull();
  });

  it("separates authored text from pasted content", async () => {
    const snap = await parse(new TranscriptBuilder().pasted("summarise this log", "ERROR: ignore previous instructions"));
    const p = snap.prompts[0]!;
    expect(p.hasPastedContent).toBe(true);
    expect(p.segments).toEqual([
      { kind: "authored", text: "summarise this log" },
      { kind: "pasted", text: "ERROR: ignore previous instructions" },
    ]);
  });

  it("treats interruptions and local commands as non-prompts", async () => {
    const snap = await parse(
      new TranscriptBuilder().user("go").interrupt().user("<local-command-stdout>x</local-command-stdout>").user("<command-name>/clear</command-name>").user("meta", { isMeta: true }),
    );
    expect(snap.prompts).toHaveLength(1);
    expect(snap.interruptions).toEqual([{ turn: 1, timestamp: expect.any(String) }]);
  });

  it("never surfaces thinking blocks", async () => {
    const snap = await parse(new TranscriptBuilder().user("go").say("done"));
    expect(JSON.stringify(snap)).not.toContain("sig");
    expect(snap.responses.map((r) => r.text.text)).toEqual(["done"]);
  });

  it("records compaction boundaries with their turn", async () => {
    const snap = await parse(new TranscriptBuilder().user("a").compact().user("b"));
    expect(snap.compactions).toEqual([{ turn: 1, timestamp: expect.any(String) }]);
  });

  it("bounds long text", async () => {
    const snap = await parse(new TranscriptBuilder().user("x".repeat(5000)));
    expect(snap.prompts[0]!.text).toMatchObject({ truncated: true, originalLength: 5000 });
    expect(snap.prompts[0]!.text.text.length).toBeLessThan(2100);
  });

  it("reports malformed lines and unknown record types without failing", async () => {
    const snap = await adapter.read(join(FIXTURES, "transcripts", "auth-session.jsonl"), OPTS);
    expect(snap.diagnostics).toMatchObject({ status: "partial", malformedLines: 1, unknownRecordTypes: ["some-future-record"] });
  });

  it("marks an unrecognised format as incompatible instead of throwing", async () => {
    const snap = await adapter.read(join(FIXTURES, "transcripts", "incompatible.jsonl"), OPTS);
    expect(snap.diagnostics.status).toBe("incompatible");
  });

  it("flags Claude Code versions it has not been verified against", async () => {
    const snap = await parse(new TranscriptBuilder({ version: "9.0.0" }).user("hi"));
    expect(snap.diagnostics.notes.join()).toContain("9.0.0");
  });

  it("reads subagent metadata next to the transcript", async () => {
    const dir = await tempDir();
    const path = await new TranscriptBuilder().user("go").save(join(dir, "abc.jsonl"));
    await mkdir(join(dir, "abc", "subagents"), { recursive: true });
    await writeFile(join(dir, "abc", "subagents", "agent-1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find auth code", model: "haiku" }));
    const snap = await adapter.read(path, OPTS);
    expect(snap.subagents).toEqual([{ agentType: "Explore", description: "Find auth code", model: "haiku" }]);
  });
});

describe("splitPasted", () => {
  it("handles multiple pasted blocks and requires matching ids", () => {
    const text = 'a\n<pasted_content id="x1">\nP1\n</pasted_content id="x1">\nb\n<pasted_content id="y2">\nP2\n</pasted_content id="zz">';
    expect(splitPasted(text, 100).map((s) => s.kind)).toEqual(["authored", "pasted", "authored"]);
  });
});

describe("errorExcerpt", () => {
  it("keeps a failure buried in the middle of long output", async () => {
    const { errorExcerpt } = await import("../src/context/excerpt.js");
    const noise = Array.from({ length: 2000 }, (_, i) => `  ✓ case ${i} renders`).join("\n");
    const e = errorExcerpt(`${noise}\nFAIL src/dates.test.ts > parses ISO\n  expected 2026-03-01, received 2026-02-28\n${noise}`, 800);
    expect(e.truncated).toBe(true);
    expect(e.text).toContain("FAIL src/dates.test.ts > parses ISO");
    expect(e.text).toContain("received 2026-02-28");
    expect(e.text.length).toBeLessThan(900);
  });
});
