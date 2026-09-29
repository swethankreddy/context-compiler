/**
 * Deterministic compression. Each function keeps the parts that carry meaning
 * (errors, claims, next steps, changed lines) and says when something was dropped.
 */
import { tokens } from "./task.js";
const ERROR_LINE = /\b(error|errors|fail|failed|failing|failure|exception|assert|expected|received|cannot|can't|not found|undefined|null|denied|refused|timeout|timed out|panic|traceback|warning)\b|✗|×|✕|FAIL|ERR!/i;
function cap(text, max) {
    return text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max).trimEnd()} …`, cut: true };
}
/** Command output: error lines with one line of context; falls back to the tail. */
export function compressOutput(text, max = 600) {
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (clean.length <= max)
        return { text: clean, truncated: false };
    const lines = clean.split("\n");
    const keep = new Set();
    lines.forEach((l, i) => {
        if (ERROR_LINE.test(l))
            [i - 1, i, i + 1].forEach((j) => j >= 0 && j < lines.length && keep.add(j));
    });
    let picked;
    if (keep.size) {
        picked = [];
        let prev = -2;
        for (const i of [...keep].sort((a, b) => a - b)) {
            if (i !== prev + 1 && picked.length)
                picked.push("…");
            picked.push(lines[i]);
            prev = i;
        }
    }
    else {
        picked = ["…", ...lines.slice(-8)];
    }
    return { text: cap(picked.join("\n"), max).text, truncated: true };
}
const CLAIM = /\b(changed|updated|added|removed|deleted|fixed|created|renamed|moved|replaced|implemented|refactored|wrote|modified)\b/i;
const PROBLEM = /\b(fail\w*|error\w*|issue|bug|broken|because|cause[sd]?|root cause|problem|regress\w*|still|not working|doesn'?t|didn'?t|can'?t|unable|missing|wrong)\b/i;
const NEXT = /\b(next|then|will|should|todo|remaining|left to|need to|needs to|plan|going to|blocked|waiting)\b/i;
const TECH = /`[^`]+`|\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java|json|md|yml|yaml|toml|sql|css|html)\b|\b\w+\(\)/;
/** Claude's prose: keep sentences with claims, problems, next steps or technical specifics. */
export function compressResponse(text, max = 500) {
    const clean = text.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").trim();
    if (clean.length <= max)
        return { text: clean, truncated: false };
    const sentences = clean.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
    const scored = sentences.map((s, i) => ({
        s, i,
        w: (PROBLEM.test(s) ? 2 : 0) + (CLAIM.test(s) ? 2 : 0) + (NEXT.test(s) ? 1 : 0) + (TECH.test(s) ? 1 : 0),
    }));
    const chosen = new Set();
    let len = 0;
    for (const x of [...scored].sort((a, b) => b.w - a.w || a.i - b.i)) {
        if (x.w === 0 && chosen.size)
            break;
        if (len + x.s.length > max)
            continue;
        chosen.add(x.i);
        len += x.s.length + 1;
    }
    if (!chosen.size)
        return { text: cap(clean, max).text, truncated: true };
    return { text: scored.filter((x) => chosen.has(x.i)).map((x) => x.s).join(" "), truncated: true };
}
/** Markdown (CLAUDE.md, README): the preamble plus the sections most relevant to the task, in original order. */
export function compressMarkdown(text, taskTerms, max = 4000) {
    if (text.length <= max)
        return { text, truncated: false };
    const parts = text.split(/(?=^#{1,6}\s)/m);
    const want = new Set(taskTerms);
    const ranked = parts.map((p, i) => ({ p, i, hits: tokens(p).filter((t) => want.has(t)).length }));
    const chosen = new Set([0]);
    let len = Math.min(parts[0].length, max);
    for (const x of [...ranked.slice(1)].sort((a, b) => b.hits - a.hits || a.i - b.i)) {
        if (len + x.p.length > max)
            continue;
        chosen.add(x.i);
        len += x.p.length;
    }
    const out = ranked.filter((x) => chosen.has(x.i)).map((x) => (x.i === 0 ? cap(x.p, max).text : x.p));
    const dropped = parts.length - chosen.size;
    return { text: out.join("").trim() + (dropped ? `\n… [${dropped} section(s) omitted]` : ""), truncated: true };
}
/** Lines that carry requirements: values, identifiers, quoted text, or constraint language. */
const REQUIREMENT_LINE = /\d|`|"|'|\b(must|never|always|only|exactly|at least|at most|no more than|don'?t|do not|should|shall|required?|instead|not|max(imum)?|min(imum)?|limit|default|format|header|reject|allow|error|status|return)\b/i;
/**
 * Developer-authored text in handoff mode: kept verbatim up to `max`; beyond that, every
 * requirement-bearing line is kept (in order) and only other lines are dropped.
 */
export function preserveRequirements(text, max = 8000) {
    if (text.length <= max)
        return { text, truncated: false };
    const lines = text.split("\n");
    const keep = lines.filter((l, i) => i < 3 || REQUIREMENT_LINE.test(l));
    const joined = keep.join("\n");
    if (joined.length <= max)
        return { text: `${joined}\n… [${lines.length - keep.length} line(s) without requirements omitted]`, truncated: true };
    return { text: `${joined.slice(0, max)} … [truncated]`, truncated: true };
}
/** Lines in a source/config file that carry facts: comments, literals, numbers, TODOs, errors, signatures. */
const FILE_FACT_LINE = /\/\/|\/\*|^\s*\*|^\s*#|\d|["'`]|\b(TODO|FIXME|NOTE|XXX|must|never|only|throw|Error|assert|expect|export|function|class|const|default|return)\b/;
/**
 * What Claude learned from a file it read, without copying the file: the fact-bearing lines
 * (in order, with their line numbers) up to `max` characters. Small files are kept whole.
 */
export function fileFacts(text, max = 1500) {
    if (text.length <= max)
        return { text, truncated: false };
    const lines = text.split("\n");
    const out = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim() || !FILE_FACT_LINE.test(l))
            continue;
        const row = `${i + 1}: ${l.trimEnd().slice(0, 200)}`;
        if (used + row.length + 1 > max)
            break;
        out.push(row);
        used += row.length + 1;
    }
    return { text: `${out.join("\n")}\n… [other lines of this ${lines.length}-line file omitted]`, truncated: true };
}
/** Unified diff: headers and changed lines; context lines dropped. */
export function compressDiff(text, max = 1200) {
    if (text.length <= max)
        return { text, truncated: false };
    const kept = text.split("\n").filter((l) => /^(@@|\+|-)/.test(l) && !/^(\+\+\+|---)/.test(l));
    const { text: t } = cap(kept.join("\n"), max);
    return { text: t, truncated: true };
}
