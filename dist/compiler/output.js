/**
 * Compiler output contract. The model must return this JSON; anything else is rejected
 * and never reaches the clipboard.
 */
export const MAX_INSTRUCTION_CHARS = 8000;
/** JSON Schema passed to the provider (claude -p --json-schema). */
export const COMPILER_RESULT_SCHEMA = {
    type: "object",
    properties: {
        version: { type: "integer", const: 1 },
        instruction: { type: "string", minLength: 1, maxLength: MAX_INSTRUCTION_CHARS },
        mode: { type: "string", enum: ["direct", "context_enriched", "context_and_plan"] },
        contextUsed: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
    },
    required: ["version", "instruction", "mode", "contextUsed", "warnings"],
    additionalProperties: false,
};
export class CompilerOutputError extends Error {
    raw;
    constructor(message, raw) {
        super(message);
        this.raw = raw;
        this.name = "CompilerOutputError";
    }
}
/** Phrases that ask the agent to reproduce reasoning or stand in for effort (see policy). */
const FORBIDDEN_PHRASES = [
    [/\b(show|explain|write out|walk (me )?through|reveal|describe|share|output|print)\b[^.\n]{0,40}\b(your|the|its) (reasoning|thinking|thought process|chain[- ]of[- ]thought)\b/i, "asks for reasoning output"],
    [/\bchain[- ]of[- ]thought\b/i, "mentions chain-of-thought"],
    [/\bthink (step[- ]by[- ]step|harder|carefully|deeply|hard)\b/i, "uses think-harder wording"],
    [/\b(ultrathink|think longer)\b/i, "uses think-harder wording"],
];
/** Pulls a JSON object out of text: plain JSON, a fenced block, or the first balanced {...}. */
export function extractJson(text) {
    const t = text.trim();
    const attempts = [t];
    const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence)
        attempts.push(fence[1]);
    const start = t.indexOf("{");
    if (start !== -1) {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < t.length; i++) {
            const ch = t[i];
            if (inStr) {
                if (esc)
                    esc = false;
                else if (ch === "\\")
                    esc = true;
                else if (ch === '"')
                    inStr = false;
            }
            else if (ch === '"')
                inStr = true;
            else if (ch === "{")
                depth++;
            else if (ch === "}" && --depth === 0) {
                attempts.push(t.slice(start, i + 1));
                break;
            }
        }
    }
    for (const a of attempts) {
        try {
            return JSON.parse(a);
        }
        catch {
            // try the next form
        }
    }
    throw new CompilerOutputError("model output is not valid JSON", text.slice(0, 500));
}
/**
 * Strict validation. Unknown context ids are removed with a warning (the instruction itself
 * is still valid); everything else that doesn't match the contract is an error.
 */
export function validateCompilerResult(value, allowedContextIds) {
    const fail = (m) => {
        throw new CompilerOutputError(`invalid compiler output: ${m}`, JSON.stringify(value)?.slice(0, 500));
    };
    if (typeof value !== "object" || value === null || Array.isArray(value))
        fail("not an object");
    const v = value;
    const allowedKeys = Object.keys(COMPILER_RESULT_SCHEMA.properties);
    const extra = Object.keys(v).filter((k) => !allowedKeys.includes(k));
    if (extra.length)
        fail(`unexpected keys ${extra.join(", ")}`);
    if (v.version !== 1)
        fail("version must be 1");
    if (typeof v.instruction !== "string" || !v.instruction.trim())
        fail("instruction must be a non-empty string");
    const instruction = v.instruction.trim();
    if (instruction.length > MAX_INSTRUCTION_CHARS)
        fail(`instruction longer than ${MAX_INSTRUCTION_CHARS} chars`);
    if (!["direct", "context_enriched", "context_and_plan"].includes(v.mode))
        fail("mode must be direct, context_enriched or context_and_plan");
    const strings = (k) => {
        if (!Array.isArray(v[k]) || !v[k].every((x) => typeof x === "string"))
            fail(`${k} must be a list of strings`);
        return v[k];
    };
    const contextUsed = strings("contextUsed");
    const warnings = [...strings("warnings")];
    for (const [re, why] of FORBIDDEN_PHRASES)
        if (re.test(instruction))
            fail(`instruction ${why} (policy: no reasoning extraction / no think-harder wording)`);
    if (/<\/?(pasted_content|context|user_instruction)\b/i.test(instruction))
        fail("instruction leaks compiler input tags");
    const allowed = new Set(allowedContextIds);
    const unknown = contextUsed.filter((id) => !allowed.has(id));
    if (unknown.length)
        warnings.push(`compiler cited unknown context ids (ignored): ${unknown.join(", ")}`);
    return { version: 1, instruction, mode: v.mode, contextUsed: contextUsed.filter((id) => allowed.has(id)), warnings };
}
