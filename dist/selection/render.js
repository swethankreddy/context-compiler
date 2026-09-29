const one = (s, max) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
/** Human-readable view of a ContextBundle for `ccp context --selected`. */
export function renderBundle(b, opts = {}) {
    const out = [];
    const t = b.task;
    const intents = Object.entries(t.intents).filter(([, v]) => v).map(([k]) => k);
    out.push(`TASK  "${one(t.instruction, 100)}"`);
    out.push(`      topic terms: ${t.terms.join(", ") || "(none — vague)"}   intents: ${intents.join(", ") || "none"}`);
    out.push("", `DISCOVERED ${b.stats.discovered}   SELECTED ${b.stats.selected}   OMITTED ${b.stats.omitted}   (${b.stats.scorer}, ${b.stats.elapsedMs} ms)`);
    out.push("", "SELECTED");
    for (const s of b.selected) {
        const tag = [s.origin, s.certainty !== "confirmed" ? s.certainty.toUpperCase() : null].filter(Boolean).join(", ");
        out.push(`${String(s.rank).padStart(3)}. ${one(s.title, 70).padEnd(70)} ${s.score.total.toFixed(2).padStart(6)}  ~${s.estimatedTokens} tok  [${tag}]`);
        if (s.score.reasons.length && s.type !== "current_instruction")
            out.push(`       why: ${one(s.score.reasons.join("; "), 110)}`);
        if (opts.showContent)
            for (const line of s.content.split("\n").slice(0, 6))
                out.push(`       │ ${one(line, 110)}`);
    }
    const n = opts.showOmitted ?? 8;
    if (b.omitted.length) {
        out.push("", `TOP OMITTED (${Math.min(n, b.omitted.length)} of ${b.omitted.length})`);
        for (const o of b.omitted.slice(0, n))
            out.push(`     ${one(o.title, 60).padEnd(60)} ${o.score.toFixed(2).padStart(6)}  ${one(o.reason, 60)}`);
        const reasons = new Map();
        for (const o of b.omitted) {
            const key = o.reason.replace(/\(.*\)/, "").trim();
            reasons.set(key, (reasons.get(key) ?? 0) + 1);
        }
        out.push(`     by reason: ${[...reasons].map(([r, c]) => `${r} ×${c}`).join(" · ")}`);
    }
    out.push("", "BUDGET", `  estimated ${b.budget.estimatedTokens} / ${b.budget.maxTokens} tokens, min score ${b.budget.minScore}`);
    out.push(`  by type: ${Object.entries(b.budget.byType).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (b.warnings.length) {
        out.push("", "WARNINGS");
        for (const w of b.warnings)
            out.push(`  • ${w}`);
    }
    out.push("", "Nothing has been sent to a model.");
    return out.join("\n");
}
