import { relative } from "node:path";
import type { UserPrompt } from "./adapters/types.js";
import type { ContextSnapshot, FailureSignal } from "./snapshot.js";

const RECENT_PROMPTS = 5;
const RECENT_COMMANDS = 8;
const RECENT_ATTEMPTS = 5;
const RECENT_FAILURES = 6;
const LISTED_FILES = 8;

/** The user's own words; if they only pasted, a labelled preview of the pasted text. */
function promptLine(p: UserPrompt, max: number): string {
  const authored = p.segments.filter((x) => x.kind === "authored").map((x) => x.text).join(" ");
  if (authored) return `${oneLine(authored, max)}${p.hasPastedContent ? " [+pasted]" : ""}`;
  return `[pasted] ${oneLine(p.segments.find((x) => x.kind === "pasted")?.text ?? "", max - 9)}`;
}

function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const CERTAINTY_MARK: Record<FailureSignal["certainty"], string> = { confirmed: "confirmed", reported: "reported", uncertain: "uncertain" };

/** Concise human-readable view of a ContextSnapshot. The full detail is in `--json`. */
export function renderContextReport(s: ContextSnapshot): string {
  const out: string[] = [];
  const h = (title: string) => out.push("", title);
  const kv = (k: string, v: string) => out.push(`  ${k.padEnd(18)}${v}`);
  const rel = (p: string) => (p.startsWith(s.project.root) ? relative(s.project.root, p) || "." : p);
  const tail = <T>(xs: T[], n: number) => xs.slice(-n);
  const more = (total: number, shown: number) => total > shown && out.push(`  … ${total - shown} more (see --json)`);

  out.push("PROJECT");
  kv("root", s.project.root);
  kv("name", s.project.name);
  kv("package manager", s.project.packageManager ?? "unknown");

  h("GIT");
  const g = s.git;
  if (!g.available) kv("status", `unavailable (${g.reason})`);
  else {
    kv("branch", `${g.branch ?? "(detached)"} @ ${g.head ?? "(no commits)"}`);
    kv("state", g.clean ? "clean" : `${g.staged.length} staged, ${g.unstaged.length} unstaged, ${g.untracked.length} untracked`);
    if (g.diffStat.files.length) kv("diff stat", `+${g.diffStat.totalAdded} −${g.diffStat.totalRemoved} across ${g.diffStat.files.length} file(s)`);
    kv("diff excerpt", g.diff.included && g.diff.excerpt ? `${g.diff.excerpt.text.length} chars${g.diff.excerpt.truncated ? ` (truncated from ${g.diff.excerpt.originalLength})` : ""}` : `not included (${g.diff.reason})`);
    if (g.recentCommits[0]) kv("last commit", `${g.recentCommits[0].hash} ${oneLine(g.recentCommits[0].subject, 60)}`);
  }

  h("CLAUDE SESSION");
  kv("installed", `Claude Code ${s.claudeCode.installedVersion ?? "not found"}`);
  const ses = s.session;
  kv("detection", ses.detection.method + (ses.detection.sessionId ? ` → ${ses.detection.sessionId}` : ""));
  if (ses.detection.live) kv("live process", `pid ${ses.detection.live.pid}, ${ses.detection.live.status ?? "?"}`);
  if (ses.status !== "loaded") {
    kv("status", `${ses.status}${ses.error ? `: ${ses.error}` : ""}`);
  } else {
    const m = ses.metadata, d = ses.diagnostics;
    kv("title", m.title ?? "(none)");
    kv("model / effort", `${m.currentModel ?? "?"} / ${m.currentEffort ?? "?"}`);
    kv("parsed", `${d.adapterFormatVersion} on Claude Code ${m.claudeCodeVersions.join(", ") || "?"} → ${d.status} (${d.parsedLines}/${d.totalLines} lines)`);
    kv("span", `${m.firstTimestamp ?? "?"} → ${m.lastTimestamp ?? "?"}`);
    kv("totals", `${m.turnCount} turns, ${m.toolCallCount} tool calls, ${m.toolErrorCount} tool errors, ${m.compactionCount} compactions`);
    kv("window", `turns ${ses.window.fromTurn}–${ses.window.toTurn} (max ${ses.window.turns})`);
  }

  h("CURRENT INSTRUCTION");
  if (s.request) kv("ccp request", oneLine(s.request, 140));
  const lastPrompt = ses.status === "loaded" ? ses.task.lastUserPrompt : null;
  if (lastPrompt) kv("last to Claude", promptLine(lastPrompt, 120));
  if (!s.request && !lastPrompt) out.push("  (none)");

  if (ses.status === "loaded") {
    const t = ses.task;
    h("RECENT TASK HISTORY");
    for (const p of tail(t.recentPrompts, RECENT_PROMPTS)) {
      out.push(`  #${p.turn} user    ${promptLine(p, 120)}`);
      const reply = t.recentResponses.filter((r) => r.turn === p.turn).at(-1);
      if (reply) out.push(`      claude  ${oneLine(reply.text.text)}`);
    }
    more(t.recentPrompts.length, Math.min(RECENT_PROMPTS, t.recentPrompts.length));
    if (t.commands.length) {
      out.push("  commands:");
      for (const c of tail(t.commands, RECENT_COMMANDS)) {
        const st = c.state === "completed" ? "ok" : c.exitCode !== null ? `exit ${c.exitCode}` : c.state;
        out.push(`    #${c.turn} [${st}] ${oneLine(c.command, 100)}`);
      }
      more(t.commands.length, Math.min(RECENT_COMMANDS, t.commands.length));
    }
    const st = t.toolCallStates;
    out.push(`  tool calls: ${st.completed} completed, ${st.failed} failed, ${st.running} running, ${st.abandoned} abandoned, ${st.unknown} unknown; ${t.interruptions} interruption(s)`);
    if (ses.subagents.length) out.push(`  subagents: ${ses.subagents.map((a) => `${a.agentType ?? "?"} (${oneLine(a.description ?? "", 40)})`).join(", ")}`);

    h("FILES TOUCHED");
    const f = ses.files;
    out.push(`  confirmed changes (Edit/Write): ${f.confirmedChanges.length}`);
    for (const c of tail(f.confirmedChanges, LISTED_FILES)) out.push(`    ${rel(c.path)}  [${c.tools.join(", ")}; turn ${c.turns.join(", ")}]`);
    more(f.confirmedChanges.length, Math.min(LISTED_FILES, f.confirmedChanges.length));
    out.push(`  inferred changes (from shell commands — NOT confirmed): ${f.inferredChanges.length}`);
    for (const c of tail(f.inferredChanges, LISTED_FILES)) out.push(`    ${c.operation === "delete" ? "deleted? " : ""}${rel(c.path)}  [${c.via}, ${c.location}${c.commandFailed ? ", command failed" : ""}; turn ${c.turn}]`);
    more(f.inferredChanges.length, Math.min(LISTED_FILES, f.inferredChanges.length));
    if (f.unknownEffects.length) out.push(`  unknown effects (inline scripts that may write files): ${f.unknownEffects.length}`);
    out.push(`  observed (read): ${f.observed.length}`);
    for (const o of tail(f.observed, LISTED_FILES)) out.push(`    ${rel(o.path)}`);
    more(f.observed.length, Math.min(LISTED_FILES, f.observed.length));

    h("PREVIOUS ATTEMPTS / FAILURES");
    if (!ses.attempts.length) out.push("  no turns in the window changed files");
    for (const a of tail(ses.attempts, RECENT_ATTEMPTS)) {
      out.push(`  #${a.turn} ${oneLine(a.request, 80)}`);
      const changed = [...a.changes.confirmed.map(rel), ...a.changes.inferred.map((p) => `${rel(p)} (inferred)`)];
      out.push(`      changed   ${oneLine(changed.join(", "), 110)}`);
      out.push(`      verified  ${a.verification ? `${oneLine(a.verification.command, 60)} → ${a.verification.status}${a.verification.exitCode !== null ? ` (exit ${a.verification.exitCode})` : ""}` : "no verification command after the change"}`);
      out.push(`      outcome   ${a.outcome}`);
      for (const e of a.evidence.slice(0, 3)) out.push(`      evidence  [${e.kind}, ${e.certainty}] ${oneLine(e.detail, 90)}`);
    }
    more(ses.attempts.length, Math.min(RECENT_ATTEMPTS, ses.attempts.length));
    const loose = ses.failures.filter((x) => !ses.attempts.some((a) => a.evidence.some((e) => e.signalId === x.id)));
    if (loose.length) {
      out.push("  other failure signals:");
      for (const x of tail(loose, RECENT_FAILURES)) {
        const src = x.source.type === "tool_call" ? `${x.source.tool}${x.source.exitCode !== null ? ` exit ${x.source.exitCode}` : ""}` : x.source.type.replace("_", " ");
        out.push(`    #${x.turn} [${x.kind}, ${CERTAINTY_MARK[x.certainty]}] ${src}: ${oneLine(x.evidence, 80)}`);
      }
      more(loose.length, Math.min(RECENT_FAILURES, loose.length));
    }
  }

  h("PROJECT INSTRUCTIONS");
  if (!s.instructions.length) out.push("  none found");
  for (const f of s.instructions) {
    const state = f.read ? `${f.bytes} B, ~${f.estimatedTokens} tok${f.content?.truncated ? ", truncated" : ""}` : `NOT READ: ${f.error}`;
    out.push(`  ${f.path.padEnd(22)} ${f.type.padEnd(15)} ${state}`);
  }

  h("WARNINGS / UNKNOWNS");
  const notes = [...s.warnings, ...(ses.status === "loaded" ? ses.unknowns : [])];
  if (!notes.length) out.push("  none");
  for (const n of notes) out.push(`  • ${n}`);

  h("SIZE (≈ tokens, before selection)");
  out.push(`  ${Object.entries(s.sizes).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  out.push("", "Nothing has been sent to a model.");
  return out.join("\n");
}
