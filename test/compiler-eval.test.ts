import { describe, expect, it } from "vitest";
import { checkCompilerCase, COMPILER_CASES, unsupportedPaths } from "../src/evaluation/compiler-cases.js";
import { buildContextBundle } from "../src/selection/pipeline.js";

describe("fresh compiler evaluation set (structure only; no model calls)", () => {
  it("has the ten required scenarios A–J", () => {
    expect(COMPILER_CASES.map((c) => c.id)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  });

  for (const c of COMPILER_CASES) {
    it(`${c.id} builds a bundle with context to compile`, async () => {
      const b = buildContextBundle(await c.snapshot(), c.instruction);
      expect(b.selected[0]!.id).toBe("current_instruction");
      expect(b.selected.length).toBeGreaterThan(1);
    });
  }

  it("flags file paths absent from the input", () => {
    expect(unsupportedPaths("Edit src/auth/session.ts and src/auth/token.ts", "src/auth/session.ts")).toEqual(["src/auth/token.ts"]);
  });

  it("requires hedging for inferred subjects", () => {
    const g = COMPILER_CASES.find((c) => c.id === "G")!;
    const res = (instruction: string) => ({ version: 1 as const, instruction, mode: "context_enriched" as const, contextUsed: [], warnings: [] });
    expect(checkCompilerCase(g, res("Claude changed src/config.ts to v2. Review it."), "src/config.ts")).toContain("/config\\.ts/ stated without hedging");
    expect(checkCompilerCase(g, res("A sed command appears to have changed src/config.ts; check whether it now says v2."), "src/config.ts")).toEqual([]);
  });
});

describe("fresh compiler evaluation set 2 (structure only)", async () => {
  const { COMPILER_CASES_2 } = await import("../src/evaluation/compiler-cases-2.js");
  it("has cases K–T", () => {
    expect(COMPILER_CASES_2.map((c) => c.id)).toEqual(["K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"]);
  });
  for (const c of COMPILER_CASES_2) {
    it(`${c.id} builds a bundle with context`, async () => {
      const b = buildContextBundle(await c.snapshot(), c.instruction);
      expect(b.selected.length).toBeGreaterThan(1);
    });
  }
  it("flags generic boilerplate when minimality is required", () => {
    const k = COMPILER_CASES_2[0]!;
    const res = (instruction: string) => ({ version: 1 as const, instruction, mode: "context_enriched" as const, contextUsed: [], warnings: [] });
    expect(checkCompilerCase(k, res("Rename fmt in src/money.ts to formatPrice. Keep going until done."), "fmt src/money.ts")).toEqual(['generic boilerplate: "Keep going"']);
    expect(checkCompilerCase(k, res("Rename fmt in src/money.ts to formatPrice."), "fmt src/money.ts")).toEqual([]);
  });
});
