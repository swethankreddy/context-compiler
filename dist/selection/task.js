const STOPWORDS = new Set(("a an the to of in on for with and or but is are was were be been being this that these those it its i me my we our you your " +
    "please can could would should will just now then so do does did done make made let get got some any all from at by as into up " +
    "out about there here what which how when where who whom again also still more very really thing things stuff code file files " +
    "one ones same other new old need needs want look see try trying tried go going use using via per not no yes ok okay " +
    "whether actually maybe probably somehow properly correctly basically still really quite bit lot")
    .split(" "));
/** Words that describe what to do rather than what it's about. They drive intents, not relevance. */
const INTENT_WORDS = {
    continuation: /^(continue|resume|keep|going|left|off|carry|pick|next|finish|remaining|proceed|where)$/,
    diagnose: /^(why|fail|failing|failed|fails|failure|error|errors|broken|break|breaks|wrong|crash|crashing|issue|issues|problem|problems|bug|bugs|debug|work|working|works)$/,
    tests: /^(test|tests|testing|spec|specs|pass|passing|green|red|suite)$/,
    cleanup: /^(clean|cleanup|tidy|refactor|simplify|unused|dead|lint|format|polish|tidier)$/,
    verify: /^(check|verify|confirm|validate|ensure|works|working)$/,
};
/** File extensions carry no topic ("utils.ts" is about utils, not TypeScript). */
const EXTENSIONS = /^(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|md|json|yml|yaml|toml|css|html|sh|sql|txt)$/;
const GENERIC_VERBS = /^(fix|fixes|fixed|fixing|add|adds|update|updates|change|changes|improve|implement|handle|check|run|create|write|remove|delete|show|explain|help|better|good|bad|right)$/;
const DEICTIC = /\b(this|it|that|these|those|here|same)\b/i;
/** Light stemming so "tests"/"testing"/"tested" and "callbacks"/"callback" meet. */
export function stem(w) {
    if (w.length > 5 && w.endsWith("ing"))
        return w.slice(0, -3);
    if (w.length > 4 && w.endsWith("ed"))
        return w.slice(0, -2);
    if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses"))
        return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss"))
        return w.slice(0, -1);
    return w;
}
/** Splits text (including camelCase and paths) into lowercase words. */
export function words(text) {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1);
}
/**
 * Whether a candidate token matches a task term: exact, or one is a prefix of the other when
 * the shorter has ≥4 chars and the longer adds ≥3 (auth ↔ authentication, valid ↔ validation;
 * but not form ↔ format).
 */
export function termMatches(term, tok) {
    if (term === tok)
        return true;
    const [s, l] = term.length <= tok.length ? [term, tok] : [tok, term];
    return s.length >= 4 && l.length - s.length >= 3 && l.startsWith(s);
}
/** Normalised content tokens for matching. */
export function tokens(text) {
    return words(text).filter((w) => !STOPWORDS.has(w)).map(stem);
}
export function analyzeTask(instruction) {
    const ws = words(instruction);
    const intents = { continuation: false, diagnose: false, tests: false, cleanup: false, verify: false, deictic: DEICTIC.test(instruction) };
    const topic = [];
    for (const w of ws) {
        let isIntent = false;
        for (const [k, re] of Object.entries(INTENT_WORDS)) {
            if (re.test(w)) {
                intents[k] = true;
                isIntent = true;
            }
        }
        if (!isIntent && !STOPWORDS.has(w) && !GENERIC_VERBS.test(w) && !EXTENSIONS.test(w))
            topic.push(stem(w));
    }
    // "continue", "keep going", "where you left off" are continuation even when phrased loosely.
    if (/\b(left off|keep going|carry on|pick up where)\b/i.test(instruction))
        intents.continuation = true;
    const terms = [...new Set(topic)];
    return { instruction: instruction.trim(), terms, intents, vague: terms.length === 0 };
}
