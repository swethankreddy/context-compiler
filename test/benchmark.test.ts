import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderHistory, setupRepo, verify, writeFiles } from "../src/benchmark/harness.js";
import { SOLUTIONS } from "../src/benchmark/solutions.js";
import { BENCH_TASKS } from "../src/benchmark/tasks.js";
import { tempDir } from "./helpers.js";

describe("benchmark tasks are valid (no model calls)", () => {
  it("has ten tasks with distinct categories", () => {
    expect(BENCH_TASKS).toHaveLength(10);
    expect(new Set(BENCH_TASKS.map((t) => t.category)).size).toBe(10);
  });

  for (const t of BENCH_TASKS) {
    it(`${t.id}: hidden verifier fails at the start and passes on the reference solution`, async () => {
      const root = join(await tempDir("bench-"), "repo");
      await setupRepo(t, root);
      expect((await verify(t, root)).pass).toBe(false);
      await writeFiles(root, SOLUTIONS[t.id]!);
      expect((await verify(t, root)).pass).toBe(true);
    }, 30_000);
  }

  it("renders the prior session in record order", () => {
    const h = renderHistory(BENCH_TASKS.find((t) => t.id === "T03")!, "/r");
    expect(h.indexOf("User: the cart discount is wrong")).toBeLessThan(h.indexOf("Claude used Edit"));
    expect(h.indexOf("Claude used Bash: npm test")).toBeLessThan(h.indexOf("Claude: I changed the rounding"));
    expect(h.trim().endsWith("User: ok leave it for now")).toBe(true);
  });
});
