/**
 * The Context Compiler: ContextBundle → policy → rendered input → model → validated result.
 * Knows nothing about the transcript format or the model backend beyond LLMProvider.
 */
import type { Effort } from "../config/config.js";
import type { LLMProvider, LLMResponse } from "../llm/provider.js";
import type { ContextBundle } from "../selection/types.js";
import { renderCompilerInput, type CompilerInput, type InputOptions } from "./input.js";
import { COMPILER_RESULT_SCHEMA, extractJson, validateCompilerResult, type CompilerResult } from "./output.js";
import { resolvePolicy, type ResolvedPolicy } from "./policy.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { scrubOutput, UNTRUSTED_NOTICE } from "./untrusted.js";
import { exactValueAudit, rewriteAbsenceClaims } from "./fidelity.js";

/** Version of the compiler as a whole (policy + prompt + input/output handling). */
export const COMPILER_VERSION = "context-compiler-v7";

export interface CompileOptions extends InputOptions {
  provider: LLMProvider;
  model: string;
  effort: Effort;
  timeoutMs?: number;
}

export interface CompileOutcome {
  result: CompilerResult;
  policy: ResolvedPolicy;
  system: string;
  input: CompilerInput;
  /** False when compilation was skipped because there was nothing to add. */
  modelCalled: boolean;
  /** Output sentences removed by the untrusted-content scrub (local debugging only). */
  scrubbed?: string[];
  /** Deterministic fidelity backstops applied to the brief. */
  fidelity?: { absenceClaimsRewritten: number; exactValuesAppended: number };
  response?: Omit<LLMResponse, "text" | "structured">;
  timings: { renderMs: number; modelMs: number; validateMs: number };
}

/**
 * Nothing but the instruction survived selection: there is no context to add, so a model
 * call could only rephrase. Skip it and pass the instruction through.
 */
function nothingToAdd(bundle: ContextBundle, input: CompilerInput): boolean {
  return input.itemIds.length === 0 && bundle.selected.every((s) => s.type === "current_instruction");
}

export async function compile(bundle: ContextBundle, opts: CompileOptions): Promise<CompileOutcome> {
  const t0 = performance.now();
  const policy = resolvePolicy(bundle);
  const system = buildSystemPrompt(policy, bundle.task.handoff ? "handoff" : "instruction");
  const input = renderCompilerInput(bundle, opts);
  const renderMs = performance.now() - t0;

  if (nothingToAdd(bundle, input)) {
    return {
      result: { version: 1, instruction: bundle.task.instruction, mode: "direct", contextUsed: [], warnings: ["No relevant session context was found; the instruction is unchanged."] },
      policy, system, input, modelCalled: false,
      timings: { renderMs, modelMs: 0, validateMs: 0 },
    };
  }

  const t1 = performance.now();
  const res = await opts.provider.complete({
    system, user: input.text, model: opts.model, effort: opts.effort, jsonSchema: COMPILER_RESULT_SCHEMA, timeoutMs: opts.timeoutMs,
  });
  const modelMs = performance.now() - t1;

  const t2 = performance.now();
  let scrubbed: string[] = [];
  let fidelity = { absenceClaimsRewritten: 0, exactValuesAppended: 0 };
  const raw = res.structured !== undefined ? res.structured : extractJson(res.text);
  const result = validateCompilerResult(raw, input.itemIds);
  // Deterministic backstop: never pass on instruction-like content the developer didn't write.
  const scrub = scrubOutput(result.instruction, result.warnings, input.trustedText);
  result.instruction = scrub.instruction;
  result.warnings = scrub.warnings;
  scrubbed = scrub.removedSentences;
  // The compiler only knows what the selected context shows, never what the developer did not say.
  const absence = rewriteAbsenceClaims(result.instruction);
  result.instruction = absence.text;
  result.warnings = result.warnings.map((w) => rewriteAbsenceClaims(w).text);
  let appendedValues: string[] = [];
  if (bundle.task.handoff) {
    const audit = exactValueAudit(result.instruction, input.developerTexts);
    if (audit.appendix) result.instruction = `${result.instruction}\n\n${audit.appendix}`;
    appendedValues = audit.lines;
  }
  fidelity = { absenceClaimsRewritten: absence.count, exactValuesAppended: appendedValues.length };
  if (input.neutralized.length && !/instruction-like/i.test(result.instruction)) {
    result.instruction = `${result.instruction}\n\n${UNTRUSTED_NOTICE}`;
    result.warnings.push(`Instruction-like text in untrusted context (${input.neutralized.map((n) => n.itemId).join(", ")}) was withheld from the compiler.`);
  }
  if (input.redactions.length) {
    const kinds = [...new Set(input.redactions.flatMap((r) => r.kinds))].join(", ");
    const where = input.redactions.map((r) => r.itemId).join(", ");
    result.warnings.push(`${input.redactions.reduce((n, r) => n + r.count, 0)} likely secret(s) redacted before compilation (${kinds}; in ${where}).`);
  }
  const { text: _t, structured: _s, ...response } = res;
  return { result, policy, system, input, modelCalled: true, scrubbed, fidelity, response, timings: { renderMs, modelMs, validateMs: performance.now() - t2 } };
}
