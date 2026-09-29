/**
 * Builds ContextSnapshots from synthetic transcripts for tests and evaluations.
 * Uses the real adapter and analysis, so evaluations exercise the whole pipeline.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeJsonlAdapter } from "../context/adapters/claude-code-jsonl.js";
import { analyzeSession } from "../context/analysis/session.js";
import { excerpt, estimateTokens } from "../context/excerpt.js";
import { SNAPSHOT_SCHEMA_VERSION } from "../context/snapshot.js";
export const EVAL_ROOT = "/work/app";
export const EVAL_LIMITS = {
    maxSessionTurns: 20, maxPromptChars: 2000, maxResponseChars: 600, maxToolOutputChars: 800,
    maxDiffBytes: 8000, maxInstructionFileBytes: 16000, maxListedFiles: 50,
};
function syntheticGit(g) {
    if (!g)
        return { available: false, reason: "not-a-repository" };
    const unstaged = g.unstaged ?? [];
    const untracked = g.untracked ?? [];
    return {
        available: true, root: EVAL_ROOT, branch: g.branch ?? "main", head: "abc1234", hasCommits: true,
        clean: unstaged.length + untracked.length === 0,
        staged: [], unstaged: unstaged.map((u) => ({ path: u.path, status: "M" })), untracked,
        changedFiles: [...unstaged.map((u) => u.path), ...untracked],
        diffStat: {
            files: unstaged.map((u) => ({ path: u.path, area: "unstaged", added: u.added, removed: u.removed, binary: false })),
            totalAdded: unstaged.reduce((n, u) => n + u.added, 0), totalRemoved: unstaged.reduce((n, u) => n + u.removed, 0),
        },
        diff: { included: unstaged.some((u) => u.diff), excerpt: null },
        fileDiffs: unstaged.filter((u) => u.diff).map((u) => ({ path: u.path, excerpt: excerpt(u.diff, 2000) })),
        recentCommits: [{ hash: "abc1234", subject: "previous work", date: "2026-09-01T00:00:00Z" }],
        truncatedLists: false,
    };
}
export async function buildSnapshot(spec) {
    const detection = {
        method: spec.transcript ? "live-session" : "none",
        sessionId: spec.transcript ? "eval-session" : null,
        transcriptPath: null,
        live: spec.liveStatus
            ? { pid: 1, sessionId: "eval-session", cwd: EVAL_ROOT, status: spec.liveStatus, kind: "interactive", name: "eval", version: "2.1.283", updatedAt: 0, alive: true }
            : null,
        alternatives: [],
        notes: [],
    };
    let session = { status: "none", detection, error: null };
    if (spec.transcript) {
        const path = join(await mkdtemp(join(tmpdir(), "ccp-eval-")), "eval-session.jsonl");
        await writeFile(path, spec.transcript.toString());
        const snap = await new ClaudeCodeJsonlAdapter().read(path, { maxPromptChars: 2000, maxResponseChars: 600, maxToolOutputChars: 800 });
        session = analyzeSession(snap, EVAL_LIMITS, { ...detection, transcriptPath: path }, EVAL_ROOT);
    }
    const instructions = (spec.instructions ?? []).map((f) => {
        const content = excerpt(f.text, EVAL_LIMITS.maxInstructionFileBytes);
        return {
            path: f.path, type: f.type, scope: "project-root", bytes: f.text.length, read: true, content,
            estimatedTokens: estimateTokens(content.text.length), ...(f.summary ? { summary: f.summary } : {}),
        };
    });
    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt: "2026-09-01T00:00:00.000Z", cwd: EVAL_ROOT, request: null,
        project: { root: EVAL_ROOT, name: "app", packageManager: "npm" },
        git: syntheticGit(spec.git), instructions, claudeCode: { installedVersion: "2.1.283" }, session,
        limits: EVAL_LIMITS, sizes: {}, provenance: { filesRead: [] }, warnings: [],
    };
}
