import { join } from "node:path";
import { ClaudeCodeJsonlAdapter } from "./adapters/claude-code-jsonl.js";
import { analyzeSession } from "./analysis/session.js";
import { claudeHome, detectClaudeCodeVersion, findSession } from "./claude-session.js";
import { estimateTokens } from "./excerpt.js";
import { detectGit } from "./git.js";
import { discoverInstructions } from "./instructions.js";
import { detectProject } from "./project.js";
import { SNAPSHOT_SCHEMA_VERSION } from "./snapshot.js";
const HANDOFF_RESPONSE_CHARS = 4000;
export function limitsFromConfig(config) {
    const c = config.context;
    return {
        maxSessionTurns: c.max_session_turns,
        maxPromptChars: c.max_prompt_chars,
        maxResponseChars: c.max_response_chars,
        maxToolOutputChars: c.max_tool_output_chars,
        maxDiffBytes: c.max_diff_bytes,
        maxInstructionFileBytes: c.max_instruction_file_bytes,
        maxListedFiles: c.max_listed_files,
    };
}
/**
 * When ccp runs from inside the session, the session's last unresolved Bash call is the one
 * running ccp. It is not part of the user's task, so it is removed before analysis.
 */
export function excludeSelfInvocation(snap) {
    const i = snap.toolCalls.findLastIndex((c) => c.tool === "Bash" && c.result === null);
    if (i !== -1 && i === snap.toolCalls.length - 1)
        snap.toolCalls.splice(i, 1);
}
const size = (v) => estimateTokens(JSON.stringify(v ?? null).length);
/**
 * Builds the ContextSnapshot: everything Context Compiler knows about the current task.
 * Reads only this project's files and this project's Claude Code transcript. No network.
 */
export async function discoverContext(opts) {
    const env = opts.env ?? process.env;
    const adapter = opts.adapter ?? new ClaudeCodeJsonlAdapter();
    const configured = limitsFromConfig(opts.config);
    // Handoff: Claude's closing summaries carry remaining work, limitations and open questions.
    const limits = opts.reconstruct ? { ...configured, maxResponseChars: Math.max(configured.maxResponseChars, HANDOFF_RESPONSE_CHARS) } : configured;
    const warnings = [];
    const filesRead = [];
    opts.progress?.start("repo", "Inspecting repository");
    const git = await detectGit(opts.cwd, {
        includeDiff: opts.config.context.include_git_diff,
        maxDiffBytes: limits.maxDiffBytes,
        maxListed: limits.maxListedFiles,
        gitBin: env.CCP_GIT_BIN,
        ...(opts.reconstruct ? { handoffEvidence: true } : {}),
    });
    if (!git.available && git.reason !== "not-a-repository")
        warnings.push(`Git unavailable: ${git.reason}${git.detail ? ` (${git.detail})` : ""}`);
    const project = await detectProject(opts.cwd, git);
    const instructions = opts.config.context.include_project_instructions
        ? await discoverInstructions(project.root, opts.cwd, limits.maxInstructionFileBytes)
        : [];
    for (const f of instructions) {
        if (f.read)
            filesRead.push(join(project.root, f.path));
        else
            warnings.push(`${f.path} could not be read: ${f.error}`);
    }
    opts.progress?.done("repo", git.available ? `Repository: ${project.name} (${git.branch ?? "detached"}${git.clean ? ", clean" : `, ${git.changedFiles.length} changed`})` : `Project: ${project.name} (no git)`);
    opts.progress?.start("session", "Reading Claude session");
    const home = claudeHome(env);
    const [installedVersion, location] = await Promise.all([
        detectClaudeCodeVersion(env),
        findSession({ cwd: opts.cwd, projectRoot: project.root, home, sessionId: opts.sessionId, invokingSessionId: env.CLAUDE_CODE_SESSION_ID }),
    ]);
    filesRead.push(join(home, "sessions", "<pid>.json (live-session registry)"));
    warnings.push(...location.notes.filter((n) => n.includes("--session")));
    let session = { status: "none", detection: location, error: null };
    if (location.transcriptPath) {
        try {
            const snap = await adapter.read(location.transcriptPath, {
                maxPromptChars: limits.maxPromptChars,
                maxResponseChars: limits.maxResponseChars,
                maxToolOutputChars: limits.maxToolOutputChars,
                ...(opts.reconstruct ? { captureSearchOutput: true } : {}),
            });
            filesRead.push(location.transcriptPath);
            if (snap.subagents.length)
                filesRead.push(join(location.transcriptPath.replace(/\.jsonl$/, ""), "subagents", "*.meta.json"));
            if (snap.diagnostics.status === "incompatible") {
                session = { status: "incompatible", detection: location, error: `Transcript format not recognised by ${adapter.name}: ${snap.diagnostics.notes.join(" ")}` };
            }
            else {
                if (location.method === "invoking-session")
                    excludeSelfInvocation(snap);
                session = analyzeSession(snap, limits, location, project.root);
                warnings.push(...snap.diagnostics.notes);
            }
        }
        catch (e) {
            session = { status: "unreadable", detection: location, error: `Could not read transcript: ${e.message}` };
        }
        if (session.status !== "loaded" && session.error)
            warnings.push(session.error);
    }
    opts.progress?.done("session", session.status === "loaded" ? "Session loaded" : session.status === "none" ? "No Claude session found; continuing without it" : "Session unreadable; continuing without it");
    const sizes = {
        git_status: git.available ? size({ ...git, diff: undefined }) : 0,
        git_diff: git.available && git.diff.excerpt ? estimateTokens(git.diff.excerpt.text.length) : 0,
        instructions: instructions.reduce((n, f) => n + f.estimatedTokens, 0),
    };
    if (session.status === "loaded") {
        sizes.session_prompts = size(session.task.recentPrompts);
        sizes.session_responses = size(session.task.recentResponses);
        sizes.session_tool_calls = size(session.task.toolCalls);
        sizes.session_attempts = size(session.attempts);
        sizes.session_failures = size(session.failures);
    }
    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        cwd: opts.cwd,
        request: opts.request ?? null,
        project,
        git,
        instructions,
        claudeCode: { installedVersion },
        session,
        limits,
        sizes,
        provenance: { filesRead },
        warnings,
    };
}
