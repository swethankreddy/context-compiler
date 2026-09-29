import { describe, expect, it } from "vitest";
import { evaluateCase, SELECTION_CASES } from "../src/evaluation/selection-cases.js";
import { buildContextBundle } from "../src/selection/pipeline.js";

describe("selection evaluation set", () => {
  it("covers the twelve required scenarios", () => {
    expect(new Set(SELECTION_CASES.map((c) => c.category)).size).toBe(12);
  });

  for (const c of SELECTION_CASES) {
    it(c.name, async () => {
      const r = evaluateCase(c, buildContextBundle(await c.snapshot(), c.instruction));
      expect(r.errors).toEqual([]);
    });
  }
});
