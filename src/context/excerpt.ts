import type { Excerpt } from "./adapters/types.js";

/**
 * Bounds text to `max` characters.
 * - head: keep the start (prompts, messages)
 * - tail: keep the end (command output, where results and summaries usually are)
 * - ends: keep a little of the start and more of the end (errors: the command line and the final failure)
 */
export function excerpt(text: string, max: number, mode: "head" | "tail" | "ends" = "head"): Excerpt {
  const clean = text.replace(/\s+$/, "");
  const originalLength = clean.length;
  if (originalLength <= max) return { text: clean, truncated: false, originalLength };
  const marker = `\n… [${originalLength - max} chars omitted] …\n`;
  if (mode === "head") return { text: clean.slice(0, max) + marker.trimEnd(), truncated: true, originalLength };
  if (mode === "tail") return { text: marker.trimStart() + clean.slice(-max), truncated: true, originalLength };
  const head = Math.floor(max * 0.3);
  return { text: clean.slice(0, head) + marker + clean.slice(-(max - head)), truncated: true, originalLength };
}

const ERROR_LINE = /\b(error|errors|fail|failed|failing|failure|exception|assert\w*|expected|received|cannot|can't|not found|undefined|denied|refused|timeout|timed out|panic|traceback)\b|✗|×|✕|FAIL|ERR!/i;

/**
 * Bounds error output without losing the failure: when the text is too long, keeps a short
 * head, every line that looks like an error (with one line of context), and a short tail.
 * Plain head/tail truncation drops failures that sit in the middle of long output.
 */
export function errorExcerpt(text: string, max: number): Excerpt {
  const clean = text.replace(/\s+$/, "");
  if (clean.length <= max) return { text: clean, truncated: false, originalLength: clean.length };
  const lines = clean.split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (ERROR_LINE.test(l)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  });
  if (!keep.size) return excerpt(clean, max, "ends");
  const headBudget = Math.floor(max * 0.15), tailBudget = Math.floor(max * 0.15);
  const pick: string[] = [];
  let used = 0, prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const l = lines[i]!.slice(0, 300);
    if (used + l.length + 1 > max - headBudget - tailBudget) break;
    if (i !== prev + 1) pick.push("…");
    pick.push(l);
    used += l.length + 1;
    prev = i;
  }
  const head = clean.slice(0, headBudget);
  const tail = clean.slice(-tailBudget);
  return { text: `${head}\n${pick.join("\n")}\n…\n${tail}`, truncated: true, originalLength: clean.length };
}

/** Rough token estimate (≈4 chars/token) used for budgeting, not billing. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);
