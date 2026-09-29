export const DEFAULT_BUDGET = {
    maxTokens: 6000,
    minScore: 1.0,
    caps: {
        user_prompt: 3,
        claude_response: 3,
        attempt: 3,
        failure: 4,
        verification: 3,
        tool_call_state: 3,
        unknown: 4,
        project_instruction: 3,
        git_state: 1,
        subagent: 1,
    },
    groupCaps: [{ name: "files", types: ["confirmed_change", "inferred_change", "observed_file", "git_file_change", "unknown_effect"], max: 8 }],
};
/** Handoff needs the whole task state, so it keeps more of each kind. */
export const HANDOFF_BUDGET = {
    maxTokens: 20000,
    // Recall over precision: caps and the token budget bound the size instead.
    minScore: 0.5,
    caps: { ...DEFAULT_BUDGET.caps, user_prompt: 10, claude_response: 8, attempt: 6, failure: 6, verification: 4, compaction_summary: 2, observation: 10, file_read: 8 },
    groupCaps: [{ name: "files", types: ["confirmed_change", "inferred_change", "observed_file", "git_file_change", "unknown_effect"], max: 12 }],
};
/** Stable order: score desc, then id. */
export function order(xs) {
    return [...xs].sort((a, b) => b.s.total - a.s.total || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
}
export function select(scored, budget) {
    const sorted = order(scored);
    const excluded = new Map();
    // Re-run until no selected candidate is covered by another selected one; covered ones free budget for others.
    for (let pass = 0; pass < 4; pass++) {
        const r = greedy(sorted, budget, excluded);
        const ids = new Set(r.selected.map((x) => x.id));
        const covered = r.selected.filter((x) => x.features.coveredBy?.some((id) => ids.has(id)));
        if (!covered.length)
            return r;
        for (const x of covered)
            excluded.set(x.id, `covered by ${x.features.coveredBy.find((id) => ids.has(id))}`);
    }
    return greedy(sorted, budget, excluded);
}
function greedy(sorted, budget, excluded) {
    const selected = [];
    const omitted = [];
    const perType = new Map();
    const perGroup = new Map();
    let tokens = 0;
    const omit = (x, reason) => omitted.push({ candidateId: x.c.id, type: x.c.type, title: x.c.title, score: x.s.total, reason });
    for (const x of sorted) {
        const { c, s } = x;
        const mandatory = c.type === "current_instruction";
        if (!mandatory) {
            if (excluded.has(c.id)) {
                omit(x, excluded.get(c.id));
                continue;
            }
            if (s.total < budget.minScore && !c.features.pinned) {
                omit(x, c.features.outsideProject ? `outside the project (low-priority evidence; score ${s.total})` : `below relevance threshold (${s.total} < ${budget.minScore})`);
                continue;
            }
            const cap = budget.caps[c.type];
            if (cap !== undefined && (perType.get(c.type) ?? 0) >= cap) {
                omit(x, `${c.type} cap reached (${cap})`);
                continue;
            }
            const group = budget.groupCaps.find((g) => g.types.includes(c.type));
            if (group && (perGroup.get(group.name) ?? 0) >= group.max) {
                omit(x, `${group.name} cap reached (${group.max})`);
                continue;
            }
            if (tokens + c.estimatedTokens > budget.maxTokens) {
                omit(x, `token budget (${tokens} + ${c.estimatedTokens} > ${budget.maxTokens})`);
                continue;
            }
            if (group)
                perGroup.set(group.name, (perGroup.get(group.name) ?? 0) + 1);
        }
        perType.set(c.type, (perType.get(c.type) ?? 0) + 1);
        tokens += c.estimatedTokens;
        selected.push({ ...c, rank: selected.length + 1, score: s });
    }
    return { selected, omitted, tokens };
}
