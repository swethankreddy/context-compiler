/**
 * Final safety layer and renderer: ContextBundle → the exact text sent to the model.
 *
 * Safety: drops anything whose provenance points outside the project or at Claude Code's
 * private files, bounds every item and the total, and redacts likely secrets (visibly).
 * Rendering: deterministic apart from the pasted-content tag ids, which the guide says
 * should be random and are injectable for tests.
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ContextBundle, SelectedCandidate } from "../selection/types.js";
import { redactSecrets } from "./redact.js";
import { neutralizeUntrusted } from "./untrusted.js";
import { detectScopeLimit, type DeveloperText } from "./fidelity.js";

/** Project-policy files: rules the developer maintains for the agent. */
const POLICY_FILES = new Set(["claude-md", "claude-local-md", "agents-md"]);

/**
 * Authority is decided by provenance only: "user" (the developer's words), "project-policy"
 * (CLAUDE.md/AGENTS.md), or "evidence" (everything else, however imperatively phrased).
 */
export type Authority = "user" | "project-policy" | "evidence";
export function authorityOf(c: SelectedCandidate): Authority {
  if (c.origin === "ccp-request" || c.origin === "user-authored") return "user";
  if (c.type === "project_instruction" && POLICY_FILES.has(c.features.instructionType ?? "")) return "project-policy";
  return "evidence";
}

export interface InputOptions {
  projectRoot: string;
  claudeHome?: string;
  /** This session's transcript: the only file under ~/.claude/projects allowed as provenance. */
  transcriptPath?: string | null;
  maxItemChars?: number;
  maxTotalChars?: number;
  pastedId?: () => string;
}

export interface CompilerInput {
  /** The user message sent to the model. */
  text: string;
  /** Candidate ids rendered, in order. The model may only cite these in contextUsed. */
  itemIds: string[];
  redactions: { itemId: string; count: number; kinds: string[] }[];
  dropped: { itemId: string; reason: string }[];
  truncated: string[];
  /** Items in which dangerous lines from untrusted content were replaced before sending (lines: local debug only). */
  neutralized: { itemId: string; count: number; lines: string[] }[];
  /** Text with authority (developer and project policy), used by the output scrub. */
  trustedText: string[];
  /** The developer's own messages and pasted text as rendered (handoff exact-value audit). */
  developerTexts: DeveloperText[];
  hasPasted: boolean;
}

const DEFAULT_ITEM_CHARS = 1500;
const DEFAULT_TOTAL_CHARS = 24_000;
/** Handoff mode: developer-authored items are kept whole (up to this), and the total is larger. */
const HANDOFF_USER_ITEM_CHARS = 8000;
const HANDOFF_TOTAL_CHARS = 60_000;

export const randomPastedId = () => randomBytes(3).toString("hex").slice(0, 4);

const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** Reasons a candidate must never reach the model regardless of its score. */
function blockReason(c: SelectedCandidate, o: InputOptions, home: string): string | null {
  const p = c.provenance.path;
  if (c.features.outsideProject) return "outside the project";
  if (!p) return null;
  const base = p.split(sep).pop() ?? "";
  if (base === ".credentials.json" || base === "history.jsonl" || base.endsWith(".key")) return "private Claude Code file";
  if (within(home, p)) {
    if (o.transcriptPath && p === o.transcriptPath) return null;
    return "inside the Claude Code data directory";
  }
  if (c.provenance.source !== "ccp" && !within(o.projectRoot, p)) return "path outside the project";
  return null;
}

/** Neutralises anything in content that could close or open our tags. */
function escapeTags(s: string): string {
  return s.replace(/<(\/?)(user_instruction|context|pasted_content)\b/gi, "<​$1$2");
}

const attr = (v: string | number | undefined | null) => String(v ?? "").replace(/["<>\n]/g, " ");

export function renderCompilerInput(bundle: ContextBundle, o: InputOptions): CompilerInput {
  const home = o.claudeHome ?? join(homedir(), ".claude");
  const handoff = !!bundle.task.handoff;
  const maxItem = o.maxItemChars ?? DEFAULT_ITEM_CHARS;
  const maxTotal = handoff ? Math.max(o.maxTotalChars ?? 0, HANDOFF_TOTAL_CHARS) : (o.maxTotalChars ?? DEFAULT_TOTAL_CHARS);
  const pastedId = o.pastedId ?? randomPastedId;
  const redactions: CompilerInput["redactions"] = [];
  const dropped: CompilerInput["dropped"] = [];
  const truncated: string[] = [];
  const neutralized: CompilerInput["neutralized"] = [];
  const trustedText: string[] = [bundle.task.instruction];
  const developerTexts: DeveloperText[] = [];
  const itemIds: string[] = [];
  let hasPasted = false;

  const clean = (id: string, text: string) => {
    const r = redactSecrets(text);
    if (r.count) redactions.push({ itemId: id, count: r.count, kinds: r.kinds });
    return escapeTags(r.text);
  };

  const instruction = clean("current_instruction", bundle.task.instruction);
  const parts: string[] = [`<user_instruction>\n${instruction}\n</user_instruction>`];
  let total = parts[0]!.length;

  for (const c of bundle.selected) {
    if (c.type === "current_instruction") continue;
    const blocked = blockReason(c, o, home);
    if (blocked) {
      dropped.push({ itemId: c.id, reason: blocked });
      continue;
    }
    let body = clean(c.id, c.content);
    const authority = authorityOf(c);
    // An attempt's "request:" line quotes the developer's own words, unless they had only pasted.
    const isUserLine = (l: string) => c.type === "attempt" && l.startsWith("request: ") && !l.startsWith("request: [pasted]");
    if (authority !== "evidence") trustedText.push(body);
    else {
      trustedText.push(...body.split("\n").filter(isUserLine));
      const n = neutralizeUntrusted(body, c.origin, isUserLine);
      if (n.count) {
        neutralized.push({ itemId: c.id, count: n.count, lines: n.lines });
        body = n.text;
      }
    }
    // Handoff: the developer's own words AND the material they pasted (specs, logs, samples) are kept whole.
    const developerSupplied = authority !== "evidence" || c.origin === "pasted-content";
    const itemCap = handoff && developerSupplied ? Math.max(maxItem, HANDOFF_USER_ITEM_CHARS)
      : handoff && (c.type === "observation" || c.type === "file_read") ? Math.max(maxItem, 2500)
      // Changed files carry up to 6000 characters of changed lines; a turn's last message up to 2500.
      : handoff && (c.type === "confirmed_change" || c.type === "git_file_change") ? Math.max(maxItem, 6600)
      : handoff && c.type === "claude_response" ? Math.max(maxItem, 2700)
      : maxItem;
    if (body.length > itemCap) {
      body = `${body.slice(0, itemCap)} … [truncated]`;
      truncated.push(c.id);
    }
    if (c.type === "user_prompt" && (c.origin === "user-authored" || c.origin === "pasted-content")) {
      developerTexts.push({ turn: c.provenance.turn, pasted: c.origin === "pasted-content", text: body });
    }
    const scopeLimited = handoff && c.type === "user_prompt" && c.origin === "user-authored" && detectScopeLimit(body);
    if (c.origin === "pasted-content") {
      const id = pastedId();
      body = `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`;
      hasPasted = true;
    }
    const pv = c.provenance;
    const attrs = [
      `id="${attr(c.id)}"`,
      `type="${c.type}"`,
      `origin="${c.origin}"`,
      `authority="${authority}"`,
      `certainty="${c.certainty.toUpperCase()}"`,
      `source="${pv.source}"`,
      ...(pv.turn !== undefined ? [`turn="${pv.turn}"`] : []),
      ...(pv.path ? [`path="${attr(within(o.projectRoot, pv.path) ? relative(o.projectRoot, pv.path) || "." : pv.path)}"`] : []),
      ...(scopeLimited ? ['scope_note="this message limits what the previous agent was asked to do; it is not necessarily the scope of the task"'] : []),
    ].join(" ");
    const block = `<context ${attrs}>\n${attr(c.title).trim()}\n${body}\n</context>`;
    if (total + block.length > maxTotal) {
      dropped.push({ itemId: c.id, reason: "compiler input size limit" });
      continue;
    }
    parts.push(block);
    itemIds.push(c.id);
    total += block.length;
  }

  if (bundle.warnings.length) parts.push(`<selection_notes>\n${bundle.warnings.map((w) => `- ${w}`).join("\n")}\n</selection_notes>`);
  developerTexts.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
  return { text: parts.join("\n\n"), itemIds, redactions, dropped, truncated, neutralized, trustedText, developerTexts, hasPasted };
}
