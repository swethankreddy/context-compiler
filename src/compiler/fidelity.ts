/**
 * Deterministic fidelity backstops for handoff briefs. They do not rely on the model following
 * the prompt:
 *
 *   rewriteAbsenceClaims  — the compiler cannot know what the developer never said; it only knows
 *                           what the selected context shows. "The developer never stated X" is
 *                           rewritten to "the developer's messages in the selected handoff context
 *                           do not show X".
 *   exactValueAudit       — exact values from the developer's own messages (numbers with units,
 *                           limits, quoted or backticked strings) that the brief omits are appended
 *                           verbatim, oldest first, so they cannot be summarised away.
 *   detectScopeLimit      — developer messages that limit what the previous agent should do
 *                           ("step 1 only", "don't implement yet", "someone else will…").
 */

const SUBJECT = "(the developer|the user|you|they)";
const NEG_VERB = "(never|did not|didn't|has not|hasn't|have not|haven't)\\s+(stated|said|mentioned|specified|asked for|requested|required|state|say|mention|specify|ask for|request|require)";
const ABSENCE = new RegExp(`\\b${SUBJECT}\\s+${NEG_VERB}\\b`, "gi");
const NOT_OWN_WORDS = /\bnot in (the developer's|the user's|your|their) own words\b/gi;
const NEVER_STATED_PASSIVE = /\b(was|were|is|are) never (stated|said|mentioned|specified|requested|asked for)( by (the developer|the user|you))?\b/gi;

const possessive = (s: string) => ({ "the developer": "the developer's", "the user": "the user's", you: "your", they: "their" })[s.toLowerCase()] ?? `${s}'s`;
const keepCase = (orig: string, repl: string) => (orig[0] === orig[0]!.toUpperCase() ? repl[0]!.toUpperCase() + repl.slice(1) : repl);

/**
 * Claims that a previous agent or summary left something out. The compiler only sees the selected
 * context, so such claims are scoped to it: "Agent A's summary leaves out X" → "Agent A's summary,
 * as shown in the selected handoff context, does not include X".
 */
const OMISSION_SUBJECT = "((?:the |its |their |agent a's |the previous agent's |the earlier |the previous |the final |an earlier |a previous )*(?:previous agent|agent a|summary|session|report|message|handoff|notes?)(?:'s)?(?: (?:final|last|earlier))?(?: summary| report| message)?)";
const OMISSION_VERB = "(leaves out|left out|omits|omitted|did not (?:mention|include|list|cover)|didn't (?:mention|include|list|cover)|does not (?:mention|include|list|cover)|doesn't (?:mention|include|list|cover)|never (?:mentions|mentioned|lists|listed|includes|included))";
const OMISSION = new RegExp(`\\b${OMISSION_SUBJECT}\\s+${OMISSION_VERB}\\b`, "gi");
const LISTED_ONLY = new RegExp(`\\b${OMISSION_SUBJECT}\\s+(listed only|lists only|mentioned only|mentions only|only listed|only mentioned)\\b`, "gi");

export function rewriteAbsenceClaims(text: string): { text: string; count: number } {
  let count = 0;
  let out = text.replace(ABSENCE, (m, subj: string) => {
    count++;
    return keepCase(m, `${possessive(subj)} messages in the selected handoff context do not show`);
  });
  out = out.replace(NOT_OWN_WORDS, (_m, who: string) => {
    count++;
    return `not found in ${who} messages in the selected handoff context`;
  });
  out = out.replace(NEVER_STATED_PASSIVE, (m, be: string) => {
    count++;
    return `${be} not found in the selected handoff context`;
  });
  out = out.replace(OMISSION, (_m, subj: string) => {
    count++;
    return `${subj}, as shown in the selected handoff context, does not include`;
  });
  out = out.replace(LISTED_ONLY, (_m, subj: string, verb: string) => {
    count++;
    return `${subj}, as shown in the selected handoff context, ${verb.replace(/^only /, "").replace(/ only$/, "")} only`;
  });
  return { text: out, count };
}

/** Values a later agent must not guess: backticked/quoted text, numbers with units, and numbers after limit words. */
const VALUE_TOKENS: RegExp[] = [
  /`[^`\n]{1,80}`/g,
  /"[^"\n]{1,60}"/g,
  /\b\d+(?:[.,:]\d+)*\s?(?:%|ms|s|sec|secs|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|years?|chars?|characters?|bytes?|kb|mb|gb|px|rows?|pages?|attempts?|items?|entries|retries|requests?|times?|digits?|decimals?)\b/gi,
  /\b(?:limit|max(?:imum)?|min(?:imum)?|at least|at most|exactly|up to|within|every|per|cap(?:ped)?(?: at)?|default(?:s)?(?: to| is)?|timeout|ttl|size|length)\s*(?:of|is|to|=|:)?\s*\d+(?:[.,]\d+)?\b/gi,
];

export interface DeveloperText {
  turn?: number;
  pasted: boolean;
  text: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[`"'\s]+/g, " ").trim();

/** Numbers alone as list markers ("1." / "2)") are not values. */
const isListMarker = (line: string, token: string) => new RegExp(`^\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[.)]`).test(line);

const CORRECTION_MARKER = /\b(actually|correction|change of plan|changed|change it|instead|not \d|no longer|lower(ed)?|raise[d]?|reduce[d]?|increase[d]?|update[d]?|now|rather|scratch that|make it|should be|override|supersede)/i;
const SUBJECT_STOP = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "is", "are", "be", "at", "up", "per", "we", "our", "it", "its", "with", "not", "no", "do", "don't", "must", "should", "can", "may", "max", "min", "limit", "only", "each", "every", "all", "any", "this", "that", "than", "from", "by", "as", "clients", "client"]);
/** Subject words compared by a 4-letter prefix, so "retry"/"retries" and "cap"/"caps" meet. */
const subjectWords = (line: string) =>
  new Set(line.toLowerCase().replace(/`[^`]*`|"[^"]*"|\d+([.,:]\d+)*/g, " ").split(/[^a-z]+/).filter((w) => w.length > 2 && !SUBJECT_STOP.has(w)).map((w) => w.slice(0, 4)));
const numbersIn = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);

/** Values whose numbers the brief already presents as superseded ("earlier 3", "was 5 minutes", "replaced 25%"). */
function markedSupersededInBrief(brief: string, nums: Set<string>): boolean {
  for (const n of nums) {
    const re = new RegExp(`(earlier|previous(ly)?|superseded|was|old|originally|replaced|corrected from|instead of|not)[^.\\n]{0,40}\\b${n.replace(/[.,]/g, "\\$&")}\\b`, "i");
    if (re.test(brief)) return true;
  }
  return false;
}

export function exactValueAudit(brief: string, developer: DeveloperText[], maxLines = 30): { appendix: string; lines: string[]; superseded: string[] } {
  const b = norm(brief);
  // All developer lines in chronological order, for supersession checks.
  const all: { d: DeveloperText; line: string; idx: number }[] = [];
  for (const d of developer) {
    for (const raw of d.text.split(/\n|(?<=[.;!?])\s+(?=[A-Z(`"-])/)) {
      const line = raw.trim().replace(/^[-*•]\s*/, "");
      if (line && line.length <= 400) all.push({ d, line, idx: all.length });
    }
  }
  /** A later developer line on the same subject, with a correction marker and a different value. */
  const supersededBy = (x: (typeof all)[number]) => {
    const subj = subjectWords(x.line);
    const nums = numbersIn(x.line);
    return all.find((y) => {
      if (y.idx <= x.idx || !CORRECTION_MARKER.test(y.line)) return false;
      const ynums = numbersIn(y.line);
      if (!ynums.size || [...ynums].every((n) => nums.has(n))) return false;
      const ysubj = subjectWords(y.line);
      return [...subj].filter((w) => ysubj.has(w)).length >= 1;
    });
  };
  const current: string[] = [];
  const superseded: string[] = [];
  for (const x of all) {
    // A correction's numbers are values even without a unit ("caps retries at 2, not 3").
    const tokens = [...VALUE_TOKENS.flatMap((re) => x.line.match(re) ?? []), ...(CORRECTION_MARKER.test(x.line) ? (x.line.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []) : [])].filter((t) => !isListMarker(x.line, t));
    // Compare the value itself ("max 64" → "64"), so "64 characters" in the brief counts as present.
    const core = (t: string) => norm(t.replace(/^(?:limit|max(?:imum)?|min(?:imum)?|at least|at most|exactly|up to|within|every|per|cap(?:ped)?(?: at)?|default(?:s)?(?: to| is)?|timeout|ttl|size|length)\s*(?:of|is|to|=|:)?\s*/i, ""));
    const missing = tokens.filter((t) => !b.includes(core(t)));
    if (!missing.length) continue;
    const label = `(developer${x.d.turn !== undefined ? `, turn ${x.d.turn}` : ""}${x.d.pasted ? ", pasted" : ""})`;
    const by = supersededBy(x);
    if (by || markedSupersededInBrief(brief, numbersIn(x.line))) {
      superseded.push(`- ${label} ${x.line}${by ? `  → superseded by: "${by.line.slice(0, 160)}"` : ""}`);
      continue;
    }
    current.push(`- ${label} ${x.line}`);
    if (current.length >= maxLines) break;
  }
  const parts: string[] = [];
  if (current.length) parts.push(`EXACT VALUES FROM THE DEVELOPER NOT COVERED ABOVE (current; verbatim, oldest first):\n${current.join("\n")}`);
  if (current.length && superseded.length) parts.push(`SUPERSEDED — earlier values replaced by a later message (do not use):\n${superseded.slice(0, maxLines).join("\n")}`);
  return { appendix: parts.join("\n\n"), lines: current, superseded };
}

/** Developer language that limits what the previous agent should do (not what the task requires). */
export const SCOPE_LIMIT = /\b(only (do|implement|write|work on|handle|add)|(step|part|phase) \d+ only|only (step|part|phase) \d+|for now\b|don'?t (implement|do|wire|build|write) (it|that|this|the rest|anything else)? ?yet|do not (implement|wire|build) (it|that|this|the rest)? ?yet|and (then )?stop\b|stop (after|there|before|here)|someone else will|i'?ll (pick|do|take) (up )?the rest|leave (the rest|it|that) for later|just (acknowledge|write the tests|do the parsing))/i;

export const detectScopeLimit = (text: string): boolean => SCOPE_LIMIT.test(text);
