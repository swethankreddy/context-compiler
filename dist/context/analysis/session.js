import { isAbsolute, relative } from "node:path";
import { inferShellWrites, isBenignExit1, isCompoundCommand, isTestCommand, isVerificationCommand } from "./shell.js";
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const USER_FAILURE_PATTERNS = [
    /\b(?:still|again)\b[^.!?\n]{0,40}\b(?:fail\w*|broken|break\w*|error\w*|crash\w*|wrong|not work\w*|doesn'?t work|isn'?t work\w*)/i,
    /\b(?:didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|hasn'?t|has not|not)\s+(?:fix|work|help|solve|resolve)\w*/i,
    /\bsame (?:error|issue|problem|bug|failure|result)\b/i,
    /\bno (?:change|difference|luck)\b/i,
    /\bstill (?:returning|getting|seeing|showing|happening|there|present|occurring|reproduc\w*|throwing|timing out|hanging|stale|slow|empty|null|undefined|wrong)\b/i,
];
const ASSISTANT_FAILURE_PATTERNS = [
    /\bstill (?:fail\w*|broken|not working|errors?|throw\w*)/i,
    /\b(?:fix|change|approach) (?:didn'?t|did not|doesn'?t|does not) (?:work|help|fix|resolve)/i,
    /\btests? (?:are |is )?still fail\w*/i,
    /\b\d+ tests? fail(?:ed|ing|s)?\b/i,
];
const TEST_OUTPUT_FAILURE = /(?:^|\s)FAIL(?:ED)?\b|\b[1-9]\d* (?:failed|failing|failures?)\b/m;
const firstMatch = (text, patterns) => {
    for (const p of patterns) {
        const m = text.match(p);
        if (m)
            return m;
    }
    return null;
};
/** A quote around a regex match, for evidence. */
function quoteAround(text, m, radius = 80) {
    const start = Math.max(0, (m.index ?? 0) - radius);
    const end = Math.min(text.length, (m.index ?? 0) + m[0].length + radius);
    return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}
const authoredText = (p) => p.segments.filter((s) => s.kind === "authored").map((s) => s.text).join("\n");
export function pathLocation(path, projectRoot, resolvable = true) {
    if (!resolvable || !isAbsolute(path))
        return "unknown";
    const rel = relative(projectRoot, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? "inside_project" : "outside_project";
}
/** Inline interpreter scripts (python - <<EOF, node -e …) that look like they write files. */
const INLINE_SCRIPT = /\b(?:python3?|node|ruby|perl)\s+(?:-\s*<<|<<|-c\b|-e\b)/;
const SCRIPT_WRITE = /open\([^)]*['"][wa]\+?['"]|write_text|writeFileSync|writeFile\(|\.write\(|os\.remove|unlink|rmSync|shutil\./;
function collectFiles(snap, baseDir, maxListed, projectRoot) {
    const observed = new Map();
    const confirmed = new Map();
    const inferred = [];
    const unknownEffects = [];
    for (const c of snap.toolCalls) {
        if (c.filePath && READ_TOOLS.has(c.tool) && c.result?.status !== "error") {
            observed.delete(c.filePath);
            observed.set(c.filePath, { path: c.filePath, via: c.tool, lastTurn: c.turn });
        }
        if (c.filePath && WRITE_TOOLS.has(c.tool) && c.result?.status === "ok") {
            const e = confirmed.get(c.filePath) ?? { path: c.filePath, location: pathLocation(c.filePath, projectRoot), tools: [], turns: [] };
            if (!e.tools.includes(c.tool))
                e.tools.push(c.tool);
            if (!e.turns.includes(c.turn))
                e.turns.push(c.turn);
            confirmed.delete(c.filePath);
            confirmed.set(c.filePath, e);
        }
        if (c.command) {
            for (const w of inferShellWrites(c.command, baseDir)) {
                inferred.push({
                    ...w, certainty: "inferred", location: pathLocation(w.path, projectRoot, w.confidence !== "low"),
                    turn: c.turn, toolCallId: c.id, command: c.summary, commandFailed: c.result?.status === "error",
                });
            }
            if (INLINE_SCRIPT.test(c.command) && SCRIPT_WRITE.test(c.command)) {
                unknownEffects.push({ toolCallId: c.id, turn: c.turn, command: c.summary, reason: "inline script appears to write files; which files is not established" });
            }
        }
    }
    // A path with a confirmed change doesn't also need an inferred one.
    const inferredOnly = inferred.filter((i) => !confirmed.has(i.path));
    return {
        observed: [...observed.values()].slice(-maxListed),
        confirmedChanges: [...confirmed.values()].slice(-maxListed),
        inferredChanges: inferredOnly.slice(-maxListed),
        unknownEffects: unknownEffects.slice(-maxListed),
    };
}
function collectFailures(snap) {
    const out = [];
    let n = 0;
    const id = () => `f${++n}`;
    const items = [];
    let order = 0;
    for (const p of snap.prompts) {
        items.push({
            turn: p.turn, order: order++,
            signal: () => {
                const text = authoredText(p);
                const m = firstMatch(text, USER_FAILURE_PATTERNS);
                return m ? { id: id(), kind: "user_reported", certainty: "reported", turn: p.turn, timestamp: p.timestamp, source: { type: "user_prompt" }, evidence: quoteAround(text, m) } : null;
            },
        });
    }
    for (const c of snap.toolCalls) {
        items.push({ turn: c.turn, order: order++, signal: () => toolFailure(c, id) });
    }
    for (const r of snap.responses) {
        items.push({
            turn: r.turn, order: order++,
            signal: () => {
                const m = firstMatch(r.text.text, ASSISTANT_FAILURE_PATTERNS);
                return m ? { id: id(), kind: "assistant_reported", certainty: "reported", turn: r.turn, timestamp: r.timestamp, source: { type: "assistant_message" }, evidence: quoteAround(r.text.text, m), note: "Claude's own statement; not independently verified." } : null;
            },
        });
    }
    items.sort((a, b) => a.turn - b.turn || a.order - b.order);
    for (const it of items) {
        const s = it.signal();
        if (s)
            out.push(s);
    }
    return out;
}
function toolFailure(c, id) {
    const r = c.result;
    if (!r)
        return null;
    const source = { type: "tool_call", toolCallId: c.id, tool: c.tool, command: c.command, exitCode: r.exitCode };
    const base = { turn: c.turn, timestamp: c.timestamp, source };
    const errText = r.errorText?.text ?? "";
    if (r.status === "interrupted") {
        return { id: id(), kind: "interrupted", certainty: "confirmed", ...base, evidence: errText || "(interrupted)", note: "The run was interrupted; whether the approach itself failed is unknown." };
    }
    if (r.status === "error") {
        if (c.command && isBenignExit1(c.command, r.exitCode)) {
            return { id: id(), kind: "possible_failure", certainty: "uncertain", ...base, evidence: errText, note: "Exit code 1 from this command usually means no match / differences, not an error." };
        }
        if (c.command && r.exitCode !== null) {
            if (isTestCommand(c.command) && isCompoundCommand(c.command)) {
                return { id: id(), kind: "nonzero_exit", certainty: "confirmed", ...base, evidence: errText, note: "Compound command: it failed, but which part failed (the tests or something else) is not established." };
            }
            return { id: id(), kind: isTestCommand(c.command) ? "test_failure" : "nonzero_exit", certainty: "confirmed", ...base, evidence: errText };
        }
        return { id: id(), kind: "tool_error", certainty: "confirmed", ...base, evidence: errText };
    }
    if (c.command && isTestCommand(c.command) && r.outputTail) {
        const m = r.outputTail.text.match(TEST_OUTPUT_FAILURE);
        if (m)
            return { id: id(), kind: "possible_failure", certainty: "uncertain", ...base, evidence: quoteAround(r.outputTail.text, m), note: "Test output mentions failures but the command exited 0." };
    }
    return null;
}
function buildAttempts(snap, files, failures, fromTurn, maxChars) {
    const attempts = [];
    const inferredByCall = new Map();
    for (const i of files.inferredChanges)
        inferredByCall.set(i.toolCallId, [...(inferredByCall.get(i.toolCallId) ?? []), i.path]);
    for (const p of snap.prompts.filter((p) => p.turn >= fromTurn)) {
        const calls = snap.toolCalls.filter((c) => c.turn === p.turn);
        const confirmed = [];
        const inferred = [];
        let lastChange = -1;
        calls.forEach((c, i) => {
            if (c.filePath && WRITE_TOOLS.has(c.tool) && c.result?.status === "ok") {
                if (!confirmed.includes(c.filePath))
                    confirmed.push(c.filePath);
                lastChange = i;
            }
            for (const path of inferredByCall.get(c.id) ?? []) {
                if (!inferred.includes(path) && !confirmed.includes(path))
                    inferred.push(path);
                lastChange = Math.max(lastChange, i);
            }
        });
        if (lastChange === -1)
            continue; // No change made: an investigation turn, not an attempt.
        const commands = calls
            .filter((c) => c.command)
            .map((c) => ({ command: c.summary, status: c.result?.status ?? "no result", exitCode: c.result?.exitCode ?? null, verification: isVerificationCommand(c.command) }));
        const lastVerify = calls.slice(lastChange + 1).filter((c) => c.command && isVerificationCommand(c.command)).at(-1);
        const verification = lastVerify
            ? { command: lastVerify.summary, status: lastVerify.result?.status ?? "no result", exitCode: lastVerify.result?.exitCode ?? null }
            : null;
        const turnSignals = failures.filter((f) => f.turn === p.turn);
        const nextUser = failures.filter((f) => f.turn === p.turn + 1 && f.kind === "user_reported");
        const lastVerifySignal = lastVerify ? turnSignals.find((f) => f.source.type === "tool_call" && f.source.toolCallId === lastVerify.id) : undefined;
        let outcome = "unverified";
        if (nextUser.length)
            outcome = "reported_failure";
        else if (lastVerifySignal?.certainty === "confirmed")
            outcome = "confirmed_failure";
        else if (turnSignals.some((f) => f.kind === "assistant_reported"))
            outcome = "claimed_problem";
        else if (verification?.status === "ok" && !lastVerifySignal)
            outcome = "verified_success";
        const evidence = [...turnSignals, ...nextUser].map((f) => ({
            signalId: f.id, kind: f.kind, certainty: f.certainty,
            detail: f.source.type === "tool_call" ? `${f.source.command ?? f.source.tool}${f.source.exitCode !== null ? ` → exit ${f.source.exitCode}` : ""}` : f.evidence,
        }));
        const claude = snap.responses.filter((r) => r.turn === p.turn).at(-1);
        attempts.push({
            turn: p.turn,
            request: (authoredText(p) || `[pasted] ${p.segments.find((s) => s.kind === "pasted")?.text ?? ""}`).slice(0, maxChars),
            startedAt: p.timestamp,
            changes: { confirmed, inferred },
            commands,
            verification,
            claudeSaid: claude ? claude.text.text.slice(0, maxChars) : null,
            outcome,
            evidence,
        });
    }
    return attempts;
}
export function trackToolCalls(snap, liveStatus) {
    const lastPromptTurn = snap.prompts.at(-1)?.turn ?? 0;
    const lastResolvedIndex = snap.toolCalls.findLastIndex((c) => c.result !== null);
    return snap.toolCalls.map((c, i) => {
        let state;
        if (c.result)
            state = c.result.status === "ok" ? "completed" : c.result.status === "interrupted" ? "abandoned" : "failed";
        else if (c.turn < lastPromptTurn || snap.interruptions.some((x) => x.turn === c.turn))
            state = "abandoned";
        else if (liveStatus === "busy" && i > lastResolvedIndex)
            state = "running";
        else
            state = "unknown";
        return { ...c, state };
    });
}
function unknowns(snap, files, attempts, pending) {
    const out = [];
    const lastCompaction = snap.compactions.at(-1);
    if (lastCompaction)
        out.push(`The agent's context was compacted after turn ${lastCompaction.turn}; earlier details remain in the transcript file, but the agent may now see only its summary.`);
    const last = attempts.at(-1);
    if (last?.outcome === "unverified")
        out.push(`No test/build/check command ran after the most recent change (turn ${last.turn}); whether it works is unverified.`);
    if (files.inferredChanges.length)
        out.push(`${files.inferredChanges.length} file change(s) are inferred from shell commands and are not confirmed.`);
    if (pending)
        out.push(`${pending} tool call(s) have no recorded result and their state is unknown or still running.`);
    if (files.unknownEffects.length)
        out.push(`${files.unknownEffects.length} inline script(s) may have changed files that the transcript does not identify.`);
    const outside = files.inferredChanges.filter((c) => c.location !== "inside_project").length;
    if (outside)
        out.push(`${outside} inferred change(s) are outside the project or unresolvable.`);
    if (snap.subagents.length)
        out.push("Subagent transcripts are not read; only their type and description are known.");
    if (attempts.some((a) => a.outcome === "claimed_problem"))
        out.push("Some problems are known only from Claude's own statements.");
    return out;
}
export function analyzeSession(snap, limits, detection, projectRoot) {
    const total = snap.metadata.turnCount;
    const fromTurn = Math.max(1, total - limits.maxSessionTurns + 1);
    const inWindow = (xs) => xs.filter((x) => x.turn >= fromTurn || (total === 0 && x.turn === 0));
    const baseDir = snap.metadata.cwd ?? detection.transcriptPath ?? ".";
    const files = collectFiles(snap, baseDir, limits.maxListedFiles, projectRoot ?? snap.metadata.cwd ?? baseDir);
    const failures = inWindow(collectFailures(snap));
    const attempts = buildAttempts(snap, files, failures, fromTurn, 300);
    const toolCalls = inWindow(trackToolCalls(snap, detection.live?.status ?? null));
    const toolCallStates = { completed: 0, failed: 0, running: 0, abandoned: 0, unknown: 0 };
    for (const c of toolCalls)
        toolCallStates[c.state]++;
    const pending = toolCallStates.running + toolCallStates.unknown;
    return {
        status: "loaded",
        detection,
        metadata: snap.metadata,
        diagnostics: snap.diagnostics,
        window: { turns: limits.maxSessionTurns, fromTurn, toTurn: total },
        task: {
            lastUserPrompt: snap.prompts.at(-1) ?? null,
            recentPrompts: inWindow(snap.prompts),
            recentResponses: inWindow(snap.responses),
            toolCalls,
            commands: toolCalls
                .filter((c) => c.command)
                .map((c) => ({ command: c.summary, turn: c.turn, state: c.state, exitCode: c.result?.exitCode ?? null, verification: isVerificationCommand(c.command) })),
            toolCallStates,
            interruptions: inWindow(snap.interruptions).length,
        },
        files,
        failures,
        attempts,
        compactions: snap.compactions,
        subagents: snap.subagents,
        unknowns: unknowns(snap, files, attempts, pending),
    };
}
