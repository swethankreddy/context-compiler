import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { setupRepo, writeFiles } from "../src/benchmark/harness.js";
import { diskTranscript, recoveryPrompt, streamToTranscript, verifyTagged } from "../src/benchmark/phase7.js";
import { COMPACTION_CASES, HANDOFF_TASKS, RECOVERY_TASKS } from "../src/benchmark/phase7-tasks.js";
import type { BenchTask } from "../src/benchmark/tasks.js";
import { ClaudeCodeJsonlAdapter } from "../src/context/adapters/claude-code-jsonl.js";
import { TranscriptBuilder } from "../src/evaluation/transcript-builder.js";
import { tempDir } from "./helpers.js";

describe("Phase 7 benchmark integrity (no model calls)", () => {
  for (const t of [...RECOVERY_TASKS, ...HANDOFF_TASKS]) {
    it(`${t.id}: hidden tests fail at start and pass on the reference solution`, async () => {
      const root = join(await tempDir("p7-"), "repo");
      await setupRepo(t as unknown as BenchTask, root);
      expect((await verifyTagged(t, root)).pass).toBe(false);
      await writeFiles(root, t.solution);
      expect((await verifyTagged(t, root)).pass).toBe(true);
    }, 30_000);
  }

  for (const t of RECOVERY_TASKS) {
    it(`${t.id}: the lost facts are absent from the compacted prompt (B) and present in the full history (A)`, () => {
      const b = recoveryPrompt(t, "/r", "B");
      const a = recoveryPrompt(t, "/r", "A");
      for (const f of t.keyFacts) {
        expect(f.re.test(b), `${f.name} leaked into B`).toBe(false);
        expect(f.re.test(a), `${f.name} missing from A`).toBe(true);
      }
    });

    it(`${t.id}: the on-disk transcript keeps pre-compaction records and a summary`, async () => {
      const p = join(await tempDir(), "t.jsonl");
      await diskTranscript(t, "/r").save(p);
      const s = await new ClaudeCodeJsonlAdapter().read(p, { maxPromptChars: 5000, maxResponseChars: 5000, maxToolOutputChars: 5000 });
      expect(s.compactions).toHaveLength(1);
      expect(s.compactions[0]!.summary?.text).toBe(t.summary);
      expect(s.prompts.length).toBeGreaterThan(1);
    });
  }

  it("converts claude -p stream-json into a transcript the adapter reads", async () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 1\nFAIL", is_error: true }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Rules 1-2 done; 3-5 remain." }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ].join("\n");
    const p = join(await tempDir(), "t.jsonl");
    await writeFile(p, streamToTranscript("Implement slugify with rules 1-5", stream, "/r"));
    const s = await new ClaudeCodeJsonlAdapter().read(p, { maxPromptChars: 5000, maxResponseChars: 5000, maxToolOutputChars: 5000 });
    expect(s.prompts.map((x) => x.text.text)).toEqual(["Implement slugify with rules 1-5"]);
    expect(s.toolCalls[0]).toMatchObject({ command: "npm test", result: { status: "error", exitCode: 1 } });
    expect(s.responses.at(-1)!.text.text).toBe("Rules 1-2 done; 3-5 remain.");
    expect(s.diagnostics.status).toBe("ok");
  });

  it("has three compaction cases of each kind", () => {
    for (const k of ["explicit", "implied", "unavailable"]) expect(COMPACTION_CASES.filter((c) => c.kind === k)).toHaveLength(3);
  });

  it("compaction transcripts parse", async () => {
    for (const c of COMPACTION_CASES) {
      const p = join(await tempDir(), `${c.id}.jsonl`);
      await c.transcript(new TranscriptBuilder({ cwd: "/r" }), "/r").save(p);
      const s = await new ClaudeCodeJsonlAdapter().read(p, { maxPromptChars: 5000, maxResponseChars: 5000, maxToolOutputChars: 5000 });
      expect(s.diagnostics.status).not.toBe("incompatible");
    }
  });
});
