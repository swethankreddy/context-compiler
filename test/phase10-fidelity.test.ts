/** Phase 10 regression tests: pasted-spec truncation, wrong "unknown" labels, omission claims. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTranscript, loadTask } from "../src/benchmark/external.js";
import { compile } from "../src/compiler/compiler.js";
import { rewriteAbsenceClaims } from "../src/compiler/fidelity.js";
import { renderCompilerInput } from "../src/compiler/input.js";
import { projectSlug } from "../src/context/claude-session.js";
import { discoverContext } from "../src/context/discover.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import { buildSnapshot, EVAL_ROOT as R } from "../src/evaluation/snapshot-factory.js";
import { TranscriptBuilder } from "../src/evaluation/transcript-builder.js";
import type { LLMProvider, LLMRequest } from "../src/llm/provider.js";
import { buildContextBundle } from "../src/selection/pipeline.js";
import { tempDir } from "./helpers.js";

const tb = () => new TranscriptBuilder({ cwd: R });
class Capture implements LLMProvider {
  readonly name = "capture";
  seen = "";
  system = "";
  constructor(private readonly instruction = "Continue the task.") {}
  async complete(req: LLMRequest) {
    this.seen = req.user;
    this.system = req.system;
    return { text: "", structured: { version: 1, instruction: this.instruction, mode: "context_and_plan", contextUsed: [], warnings: [] }, model: req.model, latencyMs: 1 };
  }
}
const handoff = async (t: TranscriptBuilder, p: LLMProvider) =>
  compile(buildContextBundle(await buildSnapshot({ transcript: t }), "Continue this task.", { mode: "handoff" }), { provider: p, model: "m", effort: "medium", projectRoot: R });

const SPEC = `Ledger export API — client notes.\n${"Pagination: GET /exports/{id}/records?cursor=… returns { records, next_cursor }. Keep calling until next_cursor is null.\n".repeat(14)}Errors: 401 → LedgerAuthError, 404 → LedgerNotFoundError, 429 → LedgerRateLimitError (wait exactly Retry-After seconds, up to 5 retries), everything else → LedgerHttpError. Every error carries .requestId from the x-request-id header.\n5xx: back off 200/400/800 ms, then give up after 3 retries.`;

describe("1. pasted specifications are not truncated in handoff", () => {
  it("content beyond character 1,500 reaches the compiler", async () => {
    expect(SPEC.indexOf("LedgerHttpError")).toBeGreaterThan(1500);
    const p = new Capture();
    await handoff(tb().pasted("here are the partner docs", SPEC).edit(`${R}/src/client.js`), p);
    for (const s of ["LedgerAuthError", "LedgerHttpError", "wait exactly Retry-After seconds, up to 5 retries", "200/400/800 ms", ".requestId"]) expect(p.seen).toContain(s);
    expect(p.seen).not.toMatch(/Retry-After[^\n]*… \[truncated\]/);
  });

  it("normal mode still bounds pasted content", async () => {
    const b = buildContextBundle(await buildSnapshot({ transcript: tb().pasted("docs", SPEC).edit(`${R}/src/client.js`) }), "fix the client");
    const pasted = [...b.selected, ...b.omitted].find((x) => ("candidateId" in x ? x.candidateId : (x as { id: string }).id) === "pasted:1");
    const content = b.selected.find((x) => x.id === "pasted:1")?.content;
    expect(pasted).toBeTruthy();
    if (content) expect(content.length).toBeLessThan(700);
    void renderCompilerInput;
  });

  it("Phase 9 task c2: the full pasted spec now reaches the compiler (deterministic, no model)", async () => {
    const t = await loadTask(join(process.cwd(), "benchmark", "tasks-p9", "c2-ledgerline-export-client"));
    const root = await tempDir("p10-c2-");
    const home = await tempDir("p10-c2h-");
    await mkdir(join(home, "projects", projectSlug(root)), { recursive: true });
    await writeFile(join(home, "projects", projectSlug(root), "s.jsonl"), buildTranscript(t, root, t.events).toString());
    const ctx = await discoverContext({ cwd: root, config: DEFAULT_CONFIG, env: { CCP_CLAUDE_HOME: home } });
    const b = buildContextBundle(ctx, "Continue this task.", { mode: "handoff" });
    const input = renderCompilerInput(b, { projectRoot: root, claudeHome: home, transcriptPath: ctx.session.detection.transcriptPath });
    for (const s of ["LedgerAuthError", "LedgerNotFoundError", "LedgerRateLimitError", "LedgerHttpError"]) expect(input.text).toContain(s);
  });
});

describe("2. facts established by tool output are not reported as unknown", () => {
  it("non-test command output reaches the compiler as an OBSERVED item in handoff", async () => {
    const p = new Capture();
    await handoff(
      tb().user("sessions are split wrongly for EU users").bash("node scripts/repro-eu.mjs", { stdout: "sorted order: 2026-03-01T10:00:00+01:00, 2026-03-01T09:30:00Z (wrong: localeCompare on raw ISO strings)" }).say("The sort compares raw strings."),
      p,
    );
    expect(p.seen).toMatch(/<context id="observation:[^"]+" type="observation" origin="tool-output"[^>]*certainty="CONFIRMED"[^>]*>[\s\S]*localeCompare on raw ISO strings/);
    expect(p.system).toContain("OBSERVED: a command's output, a test run or a file read in the input shows it.");
    expect(p.system).toContain("never call it unknown or unverified");
  });

  it("long test output keeps late lines (e.g. a test name past 800 chars)", async () => {
    const out = `${"✔ passing case\n".repeat(80)}✖ parcels over 31.5 kg are rejected\n  AssertionError: expected RangeError`;
    const p = new Capture();
    await handoff(tb().user("implement shipping").write(`${R}/src/shipping.js`).bash("npm test", { exit: 1, stdout: out }), p);
    expect(p.seen).toContain("parcels over 31.5 kg are rejected");
  });

  it("observations are handoff-only (normal mode unchanged)", async () => {
    const b = buildContextBundle(await buildSnapshot({ transcript: tb().user("x").bash("node scripts/a.mjs", { stdout: "result 42" }) }), "fix x");
    expect(b.selected.concat(b.omitted as never[]).some((s: { type?: string }) => s.type === "observation")).toBe(false);
  });
});

describe("3. no unsupported claims about omissions or absence", () => {
  it.each([
    ["Agent A's summary leaves out a date-format correction.", "Agent A's summary, as shown in the selected handoff context, does not include a date-format correction."],
    ["The previous agent's final summary listed only retentionDays as remaining.", "The previous agent's final summary, as shown in the selected handoff context, listed only retentionDays as remaining."],
    ["The previous agent did not mention the cutoff date.", "The previous agent, as shown in the selected handoff context, does not include the cutoff date."],
    ["The developer never said which zone to use.", "The developer's messages in the selected handoff context do not show which zone to use."],
  ])("%s", (input, expected) => {
    expect(rewriteAbsenceClaims(input).text).toBe(expected);
  });

  it("leaves ordinary sentences alone", () => {
    for (const s of ["The summary lists the remaining work.", "The previous agent added dedupe.", "Leave out the Approx. USD line (developer decision)."]) expect(rewriteAbsenceClaims(s)).toEqual({ text: s, count: 0 });
  });

  it("is applied to compiled briefs", async () => {
    const out = await handoff(tb().user("migrate contacts").edit(`${R}/src/migrate.js`), new Capture("Agent A's summary leaves out the eu date rule."));
    expect(out.result.instruction).toBe("Agent A's summary, as shown in the selected handoff context, does not include the eu date rule.");
  });
});
