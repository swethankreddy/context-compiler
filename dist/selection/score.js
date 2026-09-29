/**
 * RANK: the default deterministic scorer. Relevance is lexical/path overlap weighted by
 * inverse document frequency across this bundle's candidates, so words that appear
 * everywhere ("src", "ts") count little and distinctive ones ("callback") count a lot.
 *
 * It implements CandidateScorer, so an embedding- or LLM-based scorer can replace it
 * without touching discovery, selection or compression.
 */
import { termMatches, tokens } from "./task.js";
const PRIOR = {
    current_instruction: 100,
    user_prompt: 0.3,
    claude_response: 0.2,
    attempt: 0.5,
    failure: 0.4,
    verification: 0.4,
    observation: 0.1,
    file_read: 0.1,
    change_summary: 0.3,
    compaction_summary: 0.2,
    confirmed_change: 0.2,
    inferred_change: 0,
    unknown_effect: 0,
    git_state: 0.6,
    git_file_change: 0.1,
    project_instruction: 0.2,
    observed_file: 0,
    tool_call_state: 0.3,
    unknown: 0.3,
    subagent: -0.3,
};
const CONFIDENCE = { confirmed: 0, reported: -0.1, inferred: -0.4, uncertain: -0.3, unknown: -0.3 };
/** Types whose value depends on being about the task; unrelated ones are penalised when the task has topic terms. */
/** Per-file types: recency alone must not pull these in, or vague instructions drown in file lists. */
const FILE_LEVEL = new Set(["confirmed_change", "inferred_change", "git_file_change", "observed_file", "unknown_effect"]);
const TOPICAL = new Set(["change_summary", "attempt", "failure", "verification", "confirmed_change", "inferred_change", "git_file_change", "observed_file", "claude_response", "user_prompt", "unknown_effect"]);
/** Requirement language: messages like these carry constraints a handoff must keep. */
const CONSTRAINT = /\b(must|should|never|always|at least|at most|exactly|no more than|only|required?|don'?t|do not)\b|\d/i;
/** A later message that overrides an earlier decision. */
const CORRECTION = /\b(no[,.—-]|not |instead|actually|change of plan|correction|rather than|scratch that|on second thought|wait[,.])/i;
/** Claude reporting a cause, finding, hypothesis or decision. */
const DISCOVERY = /\b(cause|because|root cause|found|turns out|the real|the problem|the issue|the bug|looks like|seems|hypothes|decided|decision|instead|won'?t work|didn'?t work|doesn'?t work|failed|fails|must|has to|needs to|format|constraint)\b/i;
const W = { relevance: 3.0, recencyVague: 2.0, recencyTopical: 0.6, unrelatedPenalty: 0.9, outsideProject: 2.0 };
export class LexicalScorer {
    name = "lexical-v1";
    idf = new Map();
    tokenCache = new Map();
    strongCache = new Map();
    lastTurn = 0;
    firstTurn = Infinity;
    prepare(candidates, _task) {
        this.idf.clear();
        this.tokenCache.clear();
        this.strongCache.clear();
        this.lastTurn = 0;
        this.firstTurn = Infinity;
        const df = new Map();
        for (const c of candidates) {
            const set = new Set(tokens(`${c.features.text}\n${c.features.paths.join(" ")}`));
            this.tokenCache.set(c.id, set);
            this.strongCache.set(c.id, new Set(tokens(`${c.title} ${c.features.paths.join(" ")}`)));
            for (const t of set)
                df.set(t, (df.get(t) ?? 0) + 1);
            this.lastTurn = Math.max(this.lastTurn, c.features.turn ?? 0);
            if (c.type === "user_prompt" && c.features.turn !== undefined)
                this.firstTurn = Math.min(this.firstTurn, c.features.turn);
        }
        const n = candidates.length || 1;
        for (const [t, f] of df)
            this.idf.set(t, Math.log(1 + n / f));
    }
    /**
     * Share of the task's (IDF-weighted) topic terms found in the candidate. Prefix matches count
     * (auth ↔ authentication). A match in the title or a path counts fully; in body text only, 0.7.
     */
    relevance(c, task) {
        if (!task.terms.length)
            return { value: 0, matched: [] };
        const toks = this.tokenCache.get(c.id) ?? new Set(tokens(`${c.features.text}\n${c.features.paths.join(" ")}`));
        const strong = this.strongCache.get(c.id) ?? new Set();
        const has = (set, t) => set.has(t) || (t.length >= 4 && [...set].some((x) => termMatches(t, x)));
        const n = Math.max(1, this.tokenCache.size);
        let total = 0, hit = 0;
        const matched = [];
        for (const t of task.terms) {
            const w = this.idf.get(t) ?? Math.log(1 + n);
            total += w;
            const found = has(strong, t) ? 1 : has(toks, t) ? 0.7 : 0;
            if (found) {
                hit += w * found;
                matched.push(t);
            }
        }
        return { value: total ? hit / total : 0, matched };
    }
    score(c, task) {
        const reasons = [];
        const comp = { prior: PRIOR[c.type], relevance: 0, recency: 0, failure: 0, modification: 0, instruction: 0, intent: 0, confidence: CONFIDENCE[c.certainty] };
        if (c.type === "current_instruction")
            return { total: comp.prior, components: comp, reasons: ["always included"] };
        const rel = this.relevance(c, task);
        comp.relevance = W.relevance * rel.value;
        if (rel.matched.length)
            reasons.push(`matches ${rel.matched.join(", ")}`);
        const f = c.features;
        if (f.turn !== undefined && this.lastTurn > 0) {
            // Steep decay: the latest turn counts fully, one turn back ~0.35, three back ~0.13.
            const r = Math.pow(1 + (this.lastTurn - f.turn), -1.5);
            const weight = (task.vague || task.intents.continuation) && !FILE_LEVEL.has(c.type) ? W.recencyVague : W.recencyTopical;
            comp.recency = weight * r;
            if (r === 1)
                reasons.push("latest turn");
        }
        if (f.isFailure) {
            comp.failure = task.vague ? 1.0 : 0.4 + 1.2 * rel.value;
            reasons.push("failure evidence");
        }
        if (f.isChange)
            comp.modification = rel.value > 0 ? 1.0 : FILE_LEVEL.has(c.type) ? 0.1 : 0.3;
        if (c.origin === "pasted-content")
            comp.prior -= 0.3;
        if (c.type === "project_instruction") {
            const kind = f.instructionType ?? "";
            comp.instruction = kind === "claude-md" || kind === "claude-local-md" || kind === "agents-md" ? 1.4 : kind === "readme" ? 0.2 : kind === "package-json" ? 0.2 : 0;
            if (comp.instruction >= 1)
                reasons.push("project instructions");
        }
        // Intent boosts.
        const it = task.intents;
        if (it.diagnose) {
            if (f.isFailure || (c.type === "verification" && f.isFailure))
                comp.intent += 0.8;
            if (c.type === "attempt" && f.isFailure)
                comp.intent += 0.3;
            if (c.type === "claude_response")
                comp.intent += 0.2;
        }
        if (it.tests) {
            if (c.type === "verification" && f.isTest)
                comp.intent += 1.0;
            if (c.type === "failure" && f.isTest)
                comp.intent += 0.8;
            if (f.isTest && f.isChange)
                comp.intent += 0.5;
            if (f.instructionType === "package-json")
                comp.intent += 0.8;
        }
        if (it.verify) {
            if (c.type === "verification")
                comp.intent += 0.8;
            if (c.type === "attempt")
                comp.intent += 0.3;
            if (c.type === "failure" && c.origin === "user-authored")
                comp.intent += 0.5;
        }
        if (it.continuation) {
            if ((c.type === "user_prompt" || c.type === "claude_response") && f.turn === this.lastTurn)
                comp.intent += 1.2;
            if (c.type === "tool_call_state")
                comp.intent += 1.0;
            if (c.type === "attempt" && f.turn === this.lastTurn)
                comp.intent += 0.5;
            if (c.type === "unknown")
                comp.intent += 0.4;
        }
        if (it.cleanup) {
            if (c.type === "confirmed_change" || c.type === "git_file_change" || c.type === "change_summary")
                comp.intent += 0.8;
            if (c.type === "git_state")
                comp.intent += 0.6;
            if (c.type === "project_instruction")
                comp.intent += 0.3;
            if (c.type === "failure")
                comp.intent -= 0.3;
        }
        if (task.vague && it.deictic && (c.type === "user_prompt" || c.type === "claude_response") && f.turn === this.lastTurn) {
            comp.intent += 0.8;
            reasons.push('"this/it" refers to the latest exchange');
        }
        if (comp.intent)
            reasons.push("matches instruction intent");
        if (task.handoff) {
            // The next agent has none of the conversation: the objective, constraints and outcomes matter
            // regardless of how long ago they were stated.
            const boost = {
                user_prompt: 1.5, attempt: 1.0, compaction_summary: 1.0, change_summary: 0.8, failure: 0.6,
                verification: 0.5, claude_response: 0.4, project_instruction: 0.3, tool_call_state: 0.5, unknown: 0.3, observation: 0.6, file_read: 0.5,
            };
            comp.intent += boost[c.type] ?? 0;
            if (boost[c.type])
                reasons.push("handoff: part of the task state");
            if (c.type === "user_prompt") {
                // The first request states the objective; messages with requirements state constraints.
                if (f.turn === this.firstTurn) {
                    comp.intent += 1.0;
                    reasons.push("handoff: original request");
                }
                if (CONSTRAINT.test(f.text)) {
                    comp.intent += 0.5;
                    reasons.push("handoff: states requirements");
                }
                if (CORRECTION.test(f.text)) {
                    comp.intent += 0.5;
                    reasons.push("handoff: corrects an earlier decision");
                }
            }
            if (c.type === "claude_response" && DISCOVERY.test(f.text)) {
                comp.intent += 0.6;
                reasons.push("handoff: reports a finding or decision");
            }
        }
        let total = Object.values(comp).reduce((a, b) => a + b, 0);
        // In handoff/recovery, recall matters more than topical precision: the next agent needs findings
        // even when they share no words with the instruction (e.g. "flaky" vs "timezone").
        if (!task.handoff && !task.vague && rel.value === 0 && TOPICAL.has(c.type)) {
            total -= W.unrelatedPenalty;
            reasons.push("no overlap with instruction topic");
        }
        if (f.outsideProject) {
            total -= W.outsideProject;
            reasons.push("outside the project");
        }
        if (c.certainty !== "confirmed")
            reasons.push(c.certainty);
        return { total: Math.round(total * 1000) / 1000, components: comp, reasons };
    }
}
