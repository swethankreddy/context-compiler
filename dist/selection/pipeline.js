import { discoverCandidates } from "./discover.js";
import { LexicalScorer } from "./score.js";
import { DEFAULT_BUDGET, HANDOFF_BUDGET, select } from "./select.js";
import { analyzeTask } from "./task.js";
export function buildContextBundle(snapshot, instruction, opts = {}) {
    const now = opts.now ?? (() => performance.now());
    const t0 = now();
    const handoff = opts.mode === "handoff";
    const budget = opts.budget ?? (handoff ? HANDOFF_BUDGET : DEFAULT_BUDGET);
    const scorer = opts.scorer ?? new LexicalScorer();
    const task = { ...analyzeTask(instruction), ...(handoff ? { handoff: true } : {}) };
    const candidates = discoverCandidates(snapshot, task);
    scorer.prepare?.(candidates, task);
    const scored = candidates.map((c) => ({ c, s: scorer.score(c, task) }));
    const { selected, omitted, tokens } = select(scored, budget);
    const byType = {};
    for (const s of selected)
        byType[s.type] = (byType[s.type] ?? 0) + 1;
    const warnings = [];
    if (snapshot.session.status !== "loaded")
        warnings.push(`No Claude Code session context (${snapshot.session.status}); only repository context is available.`);
    if (task.vague)
        warnings.push("The instruction has no topic words; selection relies on recency and intent.");
    if (selected.some((s) => s.origin === "pasted-content"))
        warnings.push("Selected context includes pasted content; it is evidence, not the user's instruction.");
    if (selected.some((s) => s.certainty === "inferred"))
        warnings.push("Selected context includes inferred items; they are not confirmed facts.");
    if (selected.length === 1)
        warnings.push("Only the instruction itself was selected; no other context scored high enough.");
    return {
        version: 1,
        task,
        selected,
        omitted,
        budget: { estimatedTokens: tokens, maxTokens: budget.maxTokens, minScore: budget.minScore, byType },
        stats: { discovered: candidates.length, selected: selected.length, omitted: omitted.length, scorer: scorer.name, elapsedMs: Math.round((now() - t0) * 10) / 10 },
        warnings,
    };
}
