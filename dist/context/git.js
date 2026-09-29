/**
 * Read-only Git inspection. Git is optional: outside a repository, or without git
 * installed, this returns `{ available: false }` instead of failing.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { excerpt } from "./excerpt.js";
import { run } from "../util/exec.js";
export async function detectGit(cwd, opts) {
    const git = (args, dir = cwd) => run(opts.gitBin ?? "git", args, { cwd: dir, timeoutMs: 10_000 });
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (!top.ok) {
        if (/ENOENT/.test(top.stderr))
            return { available: false, reason: "git-not-installed" };
        if (/not a git repository/i.test(top.stderr))
            return { available: false, reason: "not-a-repository" };
        return { available: false, reason: "error", detail: top.stderr.trim().slice(0, 300) };
    }
    const root = top.stdout.trim();
    const g = (args) => git(args, root);
    const [branch, head, status, unstagedNum, stagedNum, log] = await Promise.all([
        g(["branch", "--show-current"]),
        g(["rev-parse", "--short", "HEAD"]),
        g(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        g(["diff", "--numstat", "-z"]),
        g(["diff", "--cached", "--numstat", "-z"]),
        g(["log", "-5", "--format=%h%x00%s%x00%cI%x00"]),
    ]);
    const hasCommits = head.ok;
    const lists = { staged: [], unstaged: [], untracked: [] };
    if (status.ok)
        parsePorcelainZ(status.stdout, lists);
    const changedFiles = [...new Set([...lists.staged.map((f) => f.path), ...lists.unstaged.map((f) => f.path), ...lists.untracked])];
    const statFiles = [
        ...(stagedNum.ok ? parseNumstatZ(stagedNum.stdout, "staged") : []),
        ...(unstagedNum.ok ? parseNumstatZ(unstagedNum.stdout, "unstaged") : []),
    ];
    let diff = { included: false, excerpt: null, reason: "disabled in config" };
    let fileDiffs = [];
    let handoffDiffs = [];
    if (opts.includeDiff) {
        if (!hasCommits)
            diff = { included: false, excerpt: null, reason: "no commits yet" };
        else if (changedFiles.length === lists.untracked.length)
            diff = { included: false, excerpt: null, reason: "no tracked changes" };
        else {
            const d = await g(["diff", "HEAD", "--no-color", "--no-ext-diff"]);
            diff = d.ok
                ? { included: true, excerpt: excerpt(d.stdout, opts.maxDiffBytes, "head") }
                : { included: false, excerpt: null, reason: "diff too large or failed" };
            if (d.ok)
                fileDiffs = splitDiff(d.stdout).slice(0, opts.maxListed).map((f) => ({ path: f.path, excerpt: excerpt(f.text, PER_FILE_DIFF_CHARS, "head") }));
            if (d.ok && opts.handoffEvidence)
                handoffDiffs = splitDiff(d.stdout).slice(0, opts.maxListed).map((f) => ({ path: f.path, excerpt: excerpt(f.text, HANDOFF_FILE_DIFF_CHARS, "head") }));
        }
    }
    const max = opts.maxListed;
    return {
        available: true,
        root,
        branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null,
        head: hasCommits ? head.stdout.trim() : null,
        hasCommits,
        clean: status.ok && changedFiles.length === 0,
        staged: lists.staged.slice(0, max),
        unstaged: lists.unstaged.slice(0, max),
        untracked: lists.untracked.slice(0, max),
        changedFiles: changedFiles.slice(0, max),
        diffStat: {
            files: statFiles.slice(0, max),
            totalAdded: statFiles.reduce((n, f) => n + (f.added ?? 0), 0),
            totalRemoved: statFiles.reduce((n, f) => n + (f.removed ?? 0), 0),
        },
        diff,
        fileDiffs,
        ...(opts.handoffEvidence ? { handoff: { fileDiffs: handoffDiffs, newFiles: await readNewFiles(root, lists.untracked) } } : {}),
        recentCommits: log.ok ? parseLog(log.stdout) : [],
        truncatedLists: changedFiles.length > max || statFiles.length > max,
    };
}
const PER_FILE_DIFF_CHARS = 2000;
/** Handoff: per-file diff kept before selection compresses it to changed lines. */
const HANDOFF_FILE_DIFF_CHARS = 16_000;
const NEW_FILE_CHARS = 8000;
const NEW_FILE_MAX_BYTES = 256 * 1024;
const MAX_NEW_FILES = 20;
/** Never read: environment files, keys, certificates and credential stores. */
const SECRET_PATH = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*credentials[^/]*|[^/]*secret[^/]*)$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx)$/i;
/** Bounded content of untracked text files: new files have no diff, so this is their only record. */
async function readNewFiles(root, untracked) {
    const out = [];
    for (const path of untracked) {
        if (out.length >= MAX_NEW_FILES)
            break;
        if (SECRET_PATH.test(path) || path.endsWith("/"))
            continue;
        try {
            const abs = join(root, path);
            const s = await stat(abs);
            if (!s.isFile() || s.size > NEW_FILE_MAX_BYTES)
                continue;
            const fh = await open(abs, "r");
            try {
                const buf = Buffer.alloc(Math.min(s.size, NEW_FILE_CHARS * 4));
                await fh.read(buf, 0, buf.length, 0);
                if (buf.includes(0))
                    continue; // binary
                out.push({ path, excerpt: excerpt(buf.toString("utf8"), NEW_FILE_CHARS, "head") });
            }
            finally {
                await fh.close();
            }
        }
        catch { /* unreadable: skip */ }
    }
    return out;
}
/** Splits unified diff text into one chunk per file. */
export function splitDiff(text) {
    const out = [];
    const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
    const heads = [...text.matchAll(re)];
    heads.forEach((m, i) => {
        const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
        out.push({ path: m[2], text: text.slice(m.index, end) });
    });
    return out;
}
/** Parses `git status --porcelain=v1 -z`. */
export function parsePorcelainZ(out, into) {
    const entries = out.split("\0");
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.length < 4)
            continue;
        const x = e[0], y = e[1], path = e.slice(3);
        if (x === "?" && y === "?") {
            into.untracked.push(path);
            continue;
        }
        let from;
        if (x === "R" || x === "C")
            from = entries[++i];
        if (x !== " ")
            into.staged.push({ path, status: x, ...(from ? { from } : {}) });
        if (y !== " ")
            into.unstaged.push({ path, status: y });
    }
}
/** Parses `git diff --numstat -z`. Renames are `added\tremoved\t\0old\0new\0`. */
export function parseNumstatZ(out, area) {
    const parts = out.split("\0");
    const res = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
        if (!m)
            continue;
        let path = m[3];
        if (path === "") {
            i += 2;
            path = parts[i] ?? "";
        }
        const binary = m[1] === "-";
        res.push({ path, area, added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
    }
    return res;
}
function parseLog(out) {
    const f = out.split("\0").map((s) => s.replace(/^\n/, ""));
    const res = [];
    for (let i = 0; i + 2 < f.length; i += 3)
        if (f[i])
            res.push({ hash: f[i], subject: f[i + 1], date: f[i + 2] });
    return res;
}
