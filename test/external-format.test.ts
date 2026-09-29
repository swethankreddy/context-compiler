import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTranscript, checkTask, loadTask, promptFor, renderEvents, splitAtCompact } from "../src/benchmark/external.js";
import { ClaudeCodeJsonlAdapter } from "../src/context/adapters/claude-code-jsonl.js";
import { tempDir } from "./helpers.js";

async function writeTask(dir: string, over: { hidden?: string; solution?: string } = {}) {
  const f = async (p: string, c: string) => { await mkdir(join(dir, p, ".."), { recursive: true }); await writeFile(join(dir, p), c); };
  await f("task.json", JSON.stringify({ id: "demo", title: "demo", category: "api", instruction: "ok, continue", expectedChanges: ["^src/"],
    facts: [{ name: "limit 7", kind: "constraint", pattern: "\\b7 per" }, { name: "retention (never stated)", kind: "unavailable", pattern: "retention", invented: "\\b\\d+ days" }] }));
  await f("README.md", "demo");
  await f("repository/package.json", '{"type":"module","scripts":{"test":"node --test"}}');
  await f("repository/src/limit.js", "export const LIMIT = 1;\n");
  await f("hidden-tests/limit.test.js", over.hidden ?? 'import { test } from "node:test"; import assert from "node:assert"; import { LIMIT } from "../src/limit.js"; test("[constraint] limit is 7", () => assert.equal(LIMIT, 7));\n');
  await f("reference-solution/src/limit.js", over.solution ?? "export const LIMIT = 7;\n");
  const events = [{ user: "set a limit, 7 per minute" }, { read: "src/limit.js" }, ...Array.from({ length: 12 }, (_, i) => ({ claude: `step ${i}` })), { bash: "npm test", exit: 1, output: "FAIL" }, { compact: true }, { user: "back" }];
  await f("session-script/session.json", JSON.stringify({ events }));
}

describe("external benchmark format", () => {
  it("validates a correct task and loads it", async () => {
    const dir = join(await tempDir("ext-"), "demo");
    await writeTask(dir);
    const t = await loadTask(dir);
    expect(t.facts).toHaveLength(2);
    const r = await checkTask(t);
    expect(r.problems).toEqual([]);
  }, 30_000);

  it("rejects a reference solution that doesn't pass", async () => {
    const dir = join(await tempDir("ext-"), "demo");
    await writeTask(dir, { solution: "export const LIMIT = 8;\n" });
    const r = await checkTask(await loadTask(dir));
    expect(r.problems.join()).toMatch(/reference solution fails/);
  }, 30_000);

  it("builds a transcript the adapter reads, splits at compact and renders conditions", async () => {
    const dir = join(await tempDir("ext-"), "demo");
    await writeTask(dir);
    const t = await loadTask(dir);
    const p = join(await tempDir(), "s.jsonl");
    await buildTranscript(t, "/w", t.events).save(p);
    const s = await new ClaudeCodeJsonlAdapter().read(p, { maxPromptChars: 5000, maxResponseChars: 5000, maxToolOutputChars: 5000 });
    expect(s.prompts.map((x) => x.text.text)).toEqual(["set a limit, 7 per minute", "back"]);
    expect(s.compactions).toHaveLength(1);
    const { after } = splitAtCompact(t.events);
    expect(renderEvents(after)).toBe("User: back");
    const prep = { taskId: "demo", workdir: "/w", sessionId: "x", transcriptPath: "/x", compactSummary: "SUMMARY", recover: { text: "RECOVER" }, handoff: { text: "HANDOFF" } } as never;
    expect(promptFor(t, prep, "B")).toBe("SUMMARY\n\nUser: back\n\nMy next message:\nok, continue");
    expect(promptFor(t, prep, "C")).toContain("My next message:\nRECOVER");
    expect(promptFor(t, prep, "D")).toBe("continue this task");
    expect(promptFor(t, prep, "E")).toBe("HANDOFF");
    expect(promptFor(t, prep, "A")).toContain("7 per minute");
  }, 30_000);
});

describe("handoff suite", async () => {
  const { auditBrief, handoffPrompt } = await import("../src/benchmark/external.js");
  const task = {
    facts: [
      { name: "TTL 90 s (correction)", kind: "correction", pattern: "90 ?s", stale: "5 min" },
      { name: "retention (never stated)", kind: "unavailable", pattern: "retention", invented: "\\b\\d+ days" },
      { name: "keys 48 hours", kind: "constraint", pattern: "48 hours" },
      { name: "64 chars", kind: "constraint", pattern: "64 char" },
    ],
    events: [{ user: "cache prices" }],
  } as never;

  it("audits PRESERVED / DROPPED / DISTORTED / INVENTED", () => {
    const v = (brief: string) => auditBrief(task, brief).map((x) => x.verdict);
    expect(v("TTL 90 s. Keys 48 hours. Keys max 64 chars.")).toEqual(["PRESERVED", "PRESERVED", "PRESERVED", "PRESERVED"]);
    expect(v("TTL 5 min. Keep retention for 30 days.")).toEqual(["DISTORTED", "INVENTED", "DROPPED", "DROPPED"]);
    expect(v("The developer never stated that keys last 48 hours.")[2]).toBe("DISTORTED");
  });

  it("builds A/B/C prompts", () => {
    const p = { taskId: "x", workdir: "/w", brief: { text: "BRIEF" } } as never;
    expect(handoffPrompt(task, p, "A")).toContain("User: cache prices");
    expect(handoffPrompt(task, p, "A")).toMatch(/My next message:\ncontinue this task$/);
    expect(handoffPrompt(task, p, "B")).toBe("continue this task");
    expect(handoffPrompt(task, p, "C")).toBe("BRIEF");
  });
});
