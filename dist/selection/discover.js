/**
 * DISCOVER: turns a ContextSnapshot into ContextCandidates. Discovery is broad on
 * purpose; selection decides what survives. Every candidate carries its origin,
 * certainty and provenance, and its content is already compressed.
 */
import { isAbsolute, join, relative } from "node:path";
import { estimateTokens } from "../context/excerpt.js";
import { isCompoundCommand, isTestCommand, isVerificationCommand } from "../context/analysis/shell.js";
import { compressDiff, compressMarkdown, compressOutput, compressResponse, fileFacts, preserveRequirements } from "./compress.js";
const TEST_PATH = /(^|[/._-])(test|tests|spec|specs|__tests__)([/._-]|$)/i;
const MAX_UNKNOWNS = 6;
/**
 * Handoff: changed lines (or new-file content) kept per changed file. A fixed total is shared across
 * the changed files, so a small change set is shown in full and a large one stays bounded.
 * Normal mode keeps 800 characters per file.
 */
const HANDOFF_CHANGE_TOTAL_CHARS = 24_000;
const HANDOFF_CHANGE_FILE_MIN = 1500;
const HANDOFF_CHANGE_FILE_MAX = 6000;
/** Handoff: the last message of each turn (normal mode keeps 500 characters). */
const HANDOFF_LAST_RESPONSE_CHARS = 2500;
function finish(d) {
    return {
        id: d.id,
        type: d.type,
        title: d.title,
        content: d.content,
        origin: d.origin,
        certainty: d.certainty,
        provenance: d.provenance,
        features: {
            text: d.text ?? `${d.title}\n${d.content}`,
            paths: d.paths ?? [],
            ...(d.turn !== undefined ? { turn: d.turn } : {}),
            ...(d.isFailure ? { isFailure: true } : {}),
            ...(d.isChange ? { isChange: true } : {}),
            ...(d.isTest ? { isTest: true } : {}),
            ...(d.outsideProject ? { outsideProject: true } : {}),
            ...(d.coveredBy?.length ? { coveredBy: d.coveredBy } : {}),
            ...(d.pinned ? { pinned: true } : {}),
            ...(d.instructionType ? { instructionType: d.instructionType } : {}),
        },
        originalChars: d.originalChars ?? d.content.length,
        compressed: d.compressed ?? false,
        estimatedTokens: estimateTokens(d.title.length + d.content.length + 40),
    };
}
export function discoverCandidates(snap, task) {
    const out = [];
    const root = snap.project.root;
    const rel = (p) => (isAbsolute(p) && !relative(root, p).startsWith("..") ? relative(root, p) || "." : p);
    const diffByPath = new Map((snap.git.available ? snap.git.fileDiffs : []).map((d) => [join(root, d.path), d]));
    // Handoff: longer per-file diffs and the content of new (untracked) files, when discovery collected them.
    const handoffEv = task.handoff && snap.git.available ? snap.git.handoff : undefined;
    const longDiffByPath = new Map((handoffEv?.fileDiffs ?? []).map((d) => [join(root, d.path), d]));
    const newFileByPath = new Map((handoffEv?.newFiles ?? []).map((f) => [join(root, f.path), f]));
    const changedPaths = new Set([
        ...(snap.session.status === "loaded" ? snap.session.files.confirmedChanges.map((c) => c.path) : []),
        ...(snap.git.available ? snap.git.changedFiles.map((p) => join(root, p)) : []),
    ]);
    const perFile = Math.max(HANDOFF_CHANGE_FILE_MIN, Math.min(HANDOFF_CHANGE_FILE_MAX, Math.floor(HANDOFF_CHANGE_TOTAL_CHARS / Math.max(1, changedPaths.size))));
    const changeEvidence = (abs) => {
        if (!task.handoff) {
            const d = diffByPath.get(abs);
            const diff = d ? compressDiff(d.excerpt.text, 800) : null;
            return { lines: diff ? [`diff: ${diff.text}`] : [], truncated: !!diff?.truncated };
        }
        const d = longDiffByPath.get(abs) ?? diffByPath.get(abs);
        if (d) {
            const diff = compressDiff(d.excerpt.text, perFile);
            return { lines: [`diff: ${diff.text}`], truncated: diff.truncated || d.excerpt.truncated };
        }
        const f = newFileByPath.get(abs);
        if (!f)
            return { lines: [], truncated: false };
        const body = f.excerpt.text.length > perFile ? `${f.excerpt.text.slice(0, perFile).trimEnd()} …` : f.excerpt.text;
        return { lines: [`new file (untracked), current content${body !== f.excerpt.text || f.excerpt.truncated ? " (beginning only)" : ""}:\n${body}`], truncated: body !== f.excerpt.text || f.excerpt.truncated };
    };
    out.push({
        id: "current_instruction", type: "current_instruction", title: "Current instruction (ccp)",
        content: task.instruction, origin: "ccp-request", certainty: "confirmed", provenance: { source: "ccp" },
    });
    const ses = snap.session;
    if (ses.status === "loaded") {
        const sid = ses.metadata.sessionId;
        const tp = (turn, extra = {}) => ({ source: "transcript", sessionId: sid, turn, ...extra });
        const attemptTurns = new Set(ses.attempts.map((a) => a.turn));
        // Prompts: the user's own words and pasted blocks become separate candidates so provenance survives.
        for (const p of ses.task.recentPrompts) {
            const authored = p.segments.filter((s) => s.kind === "authored").map((s) => s.text).join("\n");
            const pasted = p.segments.filter((s) => s.kind === "pasted").map((s) => s.text).join("\n---\n");
            if (authored) {
                // Handoff: the developer's own words carry the requirements; keep them rather than summarise them.
                const c = task.handoff ? preserveRequirements(authored) : compressResponse(authored, 600);
                out.push({
                    id: `user_prompt:${p.turn}`, type: "user_prompt", title: `User message (turn ${p.turn})`, content: c.text,
                    origin: "user-authored", certainty: "confirmed", provenance: tp(p.turn, { timestamp: p.timestamp }), turn: p.turn,
                    text: authored, originalChars: authored.length, compressed: c.truncated,
                    // The attempt for this turn repeats the request; the message alone adds nothing then.
                    // Handoff: the developer's words must reach the compiler as their own item (authority=user),
                    // never only as a quoted line inside a derived attempt summary.
                    coveredBy: !task.handoff && attemptTurns.has(p.turn) && authored.length <= 200 ? [`attempt:${p.turn}`] : [],
                });
            }
            if (pasted) {
                const c = task.handoff ? preserveRequirements(pasted) : compressResponse(pasted, 500);
                out.push({
                    id: `pasted:${p.turn}`, type: "user_prompt", title: `Pasted content in user message (turn ${p.turn})`, content: c.text,
                    origin: "pasted-content", certainty: "confirmed", provenance: tp(p.turn, { timestamp: p.timestamp }), turn: p.turn,
                    // Matched together with the user's words it came with ("log below"); content stays the pasted text only.
                    text: `${authored}\n${pasted.slice(0, 4000)}`, originalChars: pasted.length, compressed: c.truncated,
                });
            }
        }
        // Claude's messages: the last one per turn in normal mode; every message in handoff/recovery,
        // where a discovery stated mid-turn may be the only record of it.
        const responsesByTurn = new Map();
        for (const r of ses.task.recentResponses)
            responsesByTurn.set(r.turn, [...(responsesByTurn.get(r.turn) ?? []), r]);
        for (const [turn, rs] of responsesByTurn) {
            const list = task.handoff ? rs : rs.slice(-1);
            list.forEach((r, i) => {
                const last = i === list.length - 1;
                // Handoff: a turn's last message is where Claude reports what it did, what it left and what is open.
                const c = compressResponse(r.text.text, task.handoff && last ? HANDOFF_LAST_RESPONSE_CHARS : 500);
                out.push({
                    id: last ? `claude_response:${turn}` : `claude_response:${turn}.${i + 1}`, type: "claude_response",
                    title: last ? `Claude's last message (turn ${turn})` : `Claude's message ${i + 1} (turn ${turn})`, content: c.text,
                    origin: "claude-response", certainty: "reported", provenance: tp(turn, { timestamp: r.timestamp }), turn,
                    text: r.text.text, originalChars: r.text.originalLength, compressed: c.truncated || r.text.truncated,
                });
            });
        }
        // Compaction summaries: what the agent still "remembers" after compaction (Claude-generated).
        for (const cp of ses.compactions) {
            const sm = cp.summary;
            if (!sm)
                continue;
            const c = compressResponse(sm.text, 1200);
            out.push({
                id: `compaction_summary:${cp.turn}`, type: "compaction_summary", title: `Compaction summary after turn ${cp.turn}`, content: c.text,
                origin: "claude-response", certainty: "reported", provenance: tp(cp.turn, { timestamp: cp.timestamp }), turn: cp.turn,
                text: sm.text, originalChars: sm.originalLength, compressed: c.truncated,
            });
        }
        // Attempts: turns that changed files, with evidence-based outcomes.
        const attemptOf = new Map();
        for (const a of ses.attempts) {
            for (const e of a.evidence)
                attemptOf.set(e.signalId, a.turn);
            const changed = [...a.changes.confirmed.map(rel), ...a.changes.inferred.map((p) => `${rel(p)} (inferred)`)];
            const lines = [
                `request: ${a.request.slice(0, 200)}`,
                `changed: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ` (+${changed.length - 8} more)` : ""}`,
                `verification: ${a.verification ? `${a.verification.command.slice(0, 120)} → ${a.verification.status}${a.verification.exitCode !== null ? ` (exit ${a.verification.exitCode})` : ""}` : "none after the change"}`,
                `outcome: ${a.outcome}`,
                ...a.evidence.slice(0, 3).map((e) => `evidence: [${e.kind}, ${e.certainty}] ${e.detail.slice(0, 160)}`),
                ...(a.claudeSaid ? [`Claude said (unverified): ${compressResponse(a.claudeSaid, 200).text}`] : []),
            ];
            const failed = a.outcome === "confirmed_failure" || a.outcome === "reported_failure" || a.outcome === "claimed_problem";
            out.push({
                id: `attempt:${a.turn}`, type: "attempt", title: `Attempt in turn ${a.turn}: ${a.outcome}`, content: lines.join("\n"),
                origin: "derived",
                certainty: a.outcome === "confirmed_failure" || a.outcome === "verified_success" ? "confirmed" : a.outcome === "unverified" ? "unknown" : "reported",
                provenance: tp(a.turn, { timestamp: a.startedAt, source: "analysis" }), turn: a.turn,
                paths: [...a.changes.confirmed, ...a.changes.inferred],
                text: [a.request, ...changed, ...a.commands.map((c) => c.command), a.claudeSaid ?? "", ...a.evidence.map((e) => e.detail)].join("\n"),
                isFailure: failed, isChange: true,
            });
        }
        // Failure signals.
        for (const f of ses.failures) {
            const origin = f.source.type === "tool_call" ? "tool-output" : f.source.type === "user_prompt" ? "user-authored" : "claude-response";
            const ev = compressOutput(f.evidence, 400);
            const src = f.source.type === "tool_call" ? `${f.source.tool}${f.source.command ? `: ${f.source.command.slice(0, 120)}` : ""}${f.source.exitCode !== null ? ` → exit ${f.source.exitCode}` : ""}` : f.source.type.replace("_", " ");
            const at = attemptOf.get(f.id);
            out.push({
                id: `failure:${f.id}`, type: "failure", title: `${f.kind} (${f.certainty}), turn ${f.turn}`,
                content: [`source: ${src}`, `evidence: ${ev.text}`, ...(f.note ? [`note: ${f.note}`] : [])].join("\n"),
                origin, certainty: f.certainty, provenance: tp(f.turn, { toolCallId: f.source.type === "tool_call" ? f.source.toolCallId : undefined, timestamp: f.timestamp }),
                turn: f.turn, isFailure: f.certainty !== "uncertain", isTest: f.kind === "test_failure",
                text: `${src}\n${f.evidence}`, coveredBy: at !== undefined ? [`attempt:${at}`] : [],
                originalChars: f.evidence.length, compressed: ev.truncated,
            });
        }
        // Verification: the latest test run, the latest other check, and up to two earlier failed runs.
        const runs = ses.task.toolCalls.filter((c) => c.command && isVerificationCommand(c.command));
        const lastTest = runs.findLast((c) => isTestCommand(c.command));
        const lastCheck = runs.findLast((c) => !isTestCommand(c.command));
        const failedRuns = runs.filter((c) => c.state === "failed" && c !== lastTest && c !== lastCheck).slice(-2);
        const keepRuns = runs.filter((c) => c === lastTest || c === lastCheck || failedRuns.includes(c));
        // Handoff: what Claude learned from files it read (latest read per path), as observed evidence.
        if (task.handoff) {
            const latestRead = new Map();
            for (const c of ses.task.toolCalls)
                if (c.tool === "Read" && c.filePath && c.result?.fileContent)
                    latestRead.set(c.filePath, c);
            for (const [path, c] of latestRead) {
                const fc = c.result.fileContent;
                const f = fileFacts(fc.text, 1500);
                out.push({
                    id: `file_read:${path}`, type: "file_read", title: `File read by the previous agent (turn ${c.turn}): ${rel(path)}`,
                    content: `${rel(path)} as read in turn ${c.turn} (it may have changed since)${f.truncated ? "; fact-bearing lines only" : ""}:\n${f.text}`,
                    origin: "repository-content", certainty: "confirmed", provenance: tp(c.turn, { toolCallId: c.id, path, timestamp: c.timestamp }), turn: c.turn,
                    paths: [path], text: `${path}\n${fc.text.slice(0, 6000)}`, originalChars: fc.originalLength, compressed: f.truncated || fc.truncated,
                });
            }
        }
        // Handoff: other commands' output is evidence too (a reproduction script, a printed config file).
        // Without it, facts that tool output established get reported as unknown. That includes test or
        // check runs not kept as verification items (e.g. "fails before the fix" runs, or a compound
        // command that also printed a file) and what Grep/Glob returned.
        if (task.handoff) {
            const isSearch = (c) => (c.tool === "Grep" || c.tool === "Glob") && !!c.result?.outputTail;
            for (const c of ses.task.toolCalls.filter((c) => c.result && ((c.command && (!isVerificationCommand(c.command) || !keepRuns.includes(c))) || isSearch(c)))) {
                const r = c.result;
                const body = (r.errorText ?? r.outputTail)?.text ?? "";
                if (!body.trim() || body.trim() === "ok")
                    continue;
                const o = body.length > 2000 ? compressOutput(body, 2000) : { text: body, truncated: false };
                const label = c.command ? "command" : c.tool;
                out.push({
                    id: `observation:${c.id}`, type: "observation", title: `${c.command ? "Command" : c.tool} output (turn ${c.turn}): ${c.summary.slice(0, 60)}`,
                    content: [`${label}: ${c.summary}`, `result: ${c.state}${r.exitCode != null ? `, exit ${r.exitCode}` : ""}`, `output${o.truncated ? " (excerpt)" : ""}:\n${o.text}`].join("\n"),
                    origin: "tool-output", certainty: "confirmed", provenance: tp(c.turn, { toolCallId: c.id, timestamp: c.timestamp }), turn: c.turn,
                    text: `${c.command ?? `${c.tool} ${c.summary}`}\n${body}`, originalChars: (r.errorText ?? r.outputTail)?.originalLength ?? body.length, compressed: o.truncated,
                });
            }
        }
        for (const c of keepRuns) {
            const r = c.result;
            const body = r?.errorText?.text ?? r?.outputTail?.text ?? "";
            const o = compressOutput(body, task.handoff ? 2000 : 500);
            // In a compound command the exit status may belong to another part, so a failure is not attributable to the check.
            const ambiguous = c.state === "failed" && isCompoundCommand(c.command);
            out.push({
                id: `verification:${c.id}`, type: "verification", title: `${isTestCommand(c.command) ? "Test" : "Check"} run (turn ${c.turn}): ${c.state}`,
                content: [
                    `command: ${c.summary}`,
                    `state: ${c.state}${r?.exitCode != null ? `, exit ${r.exitCode}` : ""}`,
                    ...(ambiguous ? ["note: compound command — which part failed is not established"] : []),
                    ...(body ? [`output${o.truncated ? " (excerpt)" : ""}: ${o.text}`] : []),
                ].join("\n"),
                origin: "tool-output", certainty: ambiguous ? "uncertain" : c.state === "completed" || c.state === "failed" ? "confirmed" : "unknown",
                provenance: tp(c.turn, { toolCallId: c.id, timestamp: c.timestamp }), turn: c.turn,
                isTest: isTestCommand(c.command), isFailure: c.state === "failed" && !ambiguous, text: `${c.command}\n${body}`,
                // Size and truncation of the recorded output, including the adapter's own truncation.
                originalChars: (r?.errorText ?? r?.outputTail)?.originalLength ?? body.length,
                compressed: o.truncated || !!(r?.errorText ?? r?.outputTail)?.truncated,
            });
        }
        // One compact summary per turn of what changed (confirmed and inferred, inside the project).
        const byTurn = new Map();
        for (const ch of ses.files.confirmedChanges) {
            if (ch.location !== "inside_project")
                continue;
            for (const t of ch.turns) {
                const e = byTurn.get(t) ?? { confirmed: [], inferred: [] };
                e.confirmed.push(rel(ch.path));
                byTurn.set(t, e);
            }
        }
        for (const ic of ses.files.inferredChanges) {
            if (ic.location !== "inside_project")
                continue;
            const e = byTurn.get(ic.turn) ?? { confirmed: [], inferred: [] };
            if (!e.inferred.includes(rel(ic.path)))
                e.inferred.push(rel(ic.path));
            byTurn.set(ic.turn, e);
        }
        for (const [turn, e] of byTurn) {
            if (turn < ses.window.fromTurn)
                continue;
            const list = (xs) => `${xs.slice(0, 15).join(", ")}${xs.length > 15 ? ` (+${xs.length - 15} more)` : ""}`;
            out.push({
                id: `change_summary:${turn}`, type: "change_summary", title: `Files changed in turn ${turn} (${e.confirmed.length} confirmed, ${e.inferred.length} inferred)`,
                content: [...(e.confirmed.length ? [`confirmed (Edit/Write): ${list(e.confirmed)}`] : []), ...(e.inferred.length ? [`inferred from shell (not confirmed): ${list(e.inferred)}`] : [])].join("\n"),
                origin: "derived", certainty: e.confirmed.length ? "confirmed" : "inferred", provenance: tp(turn, { source: "analysis" }), turn,
                paths: [...e.confirmed, ...e.inferred].map((p) => join(root, p)), isChange: true,
                coveredBy: attemptTurns.has(turn) ? [`attempt:${turn}`] : [],
            });
        }
        for (const ch of ses.files.confirmedChanges) {
            const ev = changeEvidence(ch.path);
            out.push({
                id: `confirmed_change:${ch.path}`, type: "confirmed_change", title: `Changed by Claude: ${rel(ch.path)}`,
                content: [`${rel(ch.path)} — ${ch.tools.join(", ")} in turn ${ch.turns.join(", ")}${ch.location !== "inside_project" ? ` [${ch.location}]` : ""}`, ...ev.lines].join("\n"),
                origin: "tool-output", certainty: "confirmed", provenance: tp(Math.max(...ch.turns), { path: ch.path }),
                turn: Math.max(...ch.turns), paths: [ch.path], isChange: true, isTest: TEST_PATH.test(ch.path),
                outsideProject: ch.location !== "inside_project", compressed: ev.truncated,
                ...(task.handoff && ch.location === "inside_project" ? { pinned: true } : {}),
            });
        }
        const seenInferred = new Map();
        for (const ic of ses.files.inferredChanges) {
            seenInferred.set(`${ic.path}:${ic.operation}`, {
                id: `inferred_change:${ic.path}:${ic.operation}`, type: "inferred_change",
                title: `INFERRED ${ic.operation} (not confirmed): ${rel(ic.path)}`,
                content: `${rel(ic.path)} — appears to be ${ic.operation === "delete" ? "deleted" : "written"} via ${ic.via} [${ic.location}${ic.commandFailed ? ", command failed" : ""}]\ncommand: ${ic.command.slice(0, 160)}`,
                origin: "derived", certainty: "inferred", provenance: tp(ic.turn, { toolCallId: ic.toolCallId, path: ic.path, source: "analysis" }),
                turn: ic.turn, paths: [ic.path], isChange: true, isTest: TEST_PATH.test(ic.path), outsideProject: ic.location !== "inside_project",
            });
        }
        out.push(...seenInferred.values());
        for (const u of ses.files.unknownEffects) {
            out.push({
                id: `unknown_effect:${u.toolCallId}`, type: "unknown_effect", title: `Possible unrecorded file changes (turn ${u.turn})`,
                content: `${u.reason}\ncommand: ${u.command.slice(0, 160)}`, origin: "derived", certainty: "unknown",
                provenance: tp(u.turn, { toolCallId: u.toolCallId, source: "analysis" }), turn: u.turn,
            });
        }
        for (const o of ses.files.observed) {
            out.push({
                id: `observed_file:${o.path}`, type: "observed_file", title: `Read by Claude: ${rel(o.path)}`, content: `${rel(o.path)} (read via ${o.via}, turn ${o.lastTurn})`,
                origin: "tool-output", certainty: "confirmed", provenance: tp(o.lastTurn, { path: o.path }), turn: o.lastTurn,
                paths: [o.path], isTest: TEST_PATH.test(o.path), outsideProject: !o.path.startsWith(root),
            });
        }
        for (const c of ses.task.toolCalls.filter((c) => c.state === "running" || c.state === "unknown" || (c.state === "abandoned" && !c.result)).slice(-5)) {
            out.push({
                id: `tool_call_state:${c.id}`, type: "tool_call_state", title: `Tool call ${c.state} (turn ${c.turn}): ${c.tool}`,
                content: `${c.tool}: ${c.summary.slice(0, 160)}\nstate: ${c.state} — no result recorded`,
                origin: "derived", certainty: c.state === "unknown" ? "unknown" : "inferred",
                provenance: tp(c.turn, { toolCallId: c.id, timestamp: c.timestamp, source: "analysis" }), turn: c.turn,
                text: `${c.tool} ${c.command ?? c.summary}`, coveredBy: keepRuns.includes(c) ? [`verification:${c.id}`] : [],
            });
        }
        ses.unknowns.slice(0, MAX_UNKNOWNS).forEach((u, i) => {
            out.push({ id: `unknown:${i}`, type: "unknown", title: "Not established by the transcript", content: u, origin: "derived", certainty: "unknown", provenance: { source: "analysis", sessionId: sid } });
        });
        ses.subagents.forEach((s, i) => {
            out.push({
                id: `subagent:${i}`, type: "subagent", title: `Subagent: ${s.agentType ?? "?"}`, content: `${s.agentType ?? "?"}: ${s.description ?? ""} (transcript not read)`,
                origin: "derived", certainty: "confirmed", provenance: { source: "transcript", sessionId: sid },
            });
        });
    }
    // Git.
    const g = snap.git;
    if (g.available) {
        const lines = [
            `branch: ${g.branch ?? "(detached)"} @ ${g.head ?? "(no commits)"}`,
            g.clean ? "working tree clean" : `${g.staged.length} staged, ${g.unstaged.length} unstaged, ${g.untracked.length} untracked; +${g.diffStat.totalAdded} −${g.diffStat.totalRemoved}`,
            ...(g.changedFiles.length ? [`changed: ${g.changedFiles.slice(0, 12).join(", ")}${g.changedFiles.length > 12 ? ` (+${g.changedFiles.length - 12} more)` : ""}`] : []),
            ...(g.recentCommits[0] ? [`last commit: ${g.recentCommits[0].hash} ${g.recentCommits[0].subject}`] : []),
        ];
        out.push({ id: "git_state", type: "git_state", title: "Git state", content: lines.join("\n"), origin: "repository-content", certainty: "confirmed", provenance: { source: "git", path: g.root } });
        const stat = new Map(g.diffStat.files.map((f) => [f.path, f]));
        const diffs = new Map(g.fileDiffs.map((d) => [d.path, d]));
        const statusOf = new Map([
            ...g.untracked.map((p) => [p, "untracked"]),
            ...g.unstaged.map((f) => [f.path, `unstaged ${f.status}`]),
            ...g.staged.map((f) => [f.path, `staged ${f.status}`]),
        ]);
        const confirmedIds = new Set(out.filter((d) => d.type === "confirmed_change").map((d) => d.id));
        for (const [path, status] of statusOf) {
            const abs = join(root, path);
            const s = stat.get(path);
            const d = diffs.get(path);
            const ev = changeEvidence(abs);
            const covering = `confirmed_change:${abs}`;
            out.push({
                id: `git_file_change:${path}`, type: "git_file_change", title: `Uncommitted change: ${path}`,
                content: [`${path} — ${status}${s ? `, +${s.added ?? "?"} −${s.removed ?? "?"}` : ""}`, ...ev.lines].join("\n"),
                origin: "repository-content", certainty: "confirmed", provenance: { source: "git", path: abs },
                paths: [abs], isChange: true, isTest: TEST_PATH.test(path), coveredBy: confirmedIds.has(covering) ? [covering] : [],
                text: `${path}\n${d?.excerpt.text.slice(0, 1500) ?? ""}`, originalChars: d?.excerpt.originalLength ?? 0, compressed: ev.truncated,
                ...(task.handoff ? { pinned: true } : {}),
            });
        }
    }
    // Project instructions.
    for (const f of snap.instructions) {
        const abs = join(root, f.path);
        if (!f.read || !f.content) {
            out.push({
                id: `project_instruction:${f.path}`, type: "project_instruction", title: `${f.path} (not read)`, content: `${f.path} exists but could not be read: ${f.error}`,
                origin: "derived", certainty: "unknown", provenance: { source: "filesystem", path: abs }, instructionType: f.type,
            });
            continue;
        }
        let content;
        let truncated = f.content.truncated;
        if (f.type === "package-json" && f.summary) {
            const s = f.summary;
            content = `name: ${s.name ?? "?"}\nscripts: ${Object.entries(s.scripts ?? {}).map(([k, v]) => `${k}=${v}`).join("; ")}`;
            truncated = true;
        }
        else if (f.type === "tsconfig") {
            content = f.content.text.slice(0, 400);
            truncated = f.content.text.length > 400;
        }
        else {
            const c = compressMarkdown(f.content.text, task.terms, f.type === "readme" ? 1200 : 3000);
            content = c.text;
            truncated ||= c.truncated;
        }
        out.push({
            id: `project_instruction:${f.path}`, type: "project_instruction", title: `${f.path} (${f.type})`, content,
            origin: "repository-content", certainty: "confirmed", provenance: { source: "filesystem", path: abs },
            paths: [abs], text: `${f.path}\n${f.content.text.slice(0, 6000)}`, originalChars: f.content.originalLength, compressed: truncated,
            instructionType: f.type,
        });
    }
    if (ses.status !== "loaded" && ses.status !== "none") {
        out.push({ id: "unknown:session", type: "unknown", title: "Session unavailable", content: ses.error ?? ses.status, origin: "derived", certainty: "unknown", provenance: { source: "analysis" } });
    }
    return out.map(finish);
}
