/**
 * Discovers project-level instruction and configuration files.
 *
 * Only files inside the project root are read. A file (or symlink) that resolves outside
 * the root is listed but not read. Content is bounded; Phase 4 decides what is relevant.
 */
import { open, lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { estimateTokens, excerpt } from "./excerpt.js";
const PER_DIR = [
    ["CLAUDE.md", "claude-md"],
    ["CLAUDE.local.md", "claude-local-md"],
    ["AGENTS.md", "agents-md"],
];
const ROOT_ONLY = [
    [".claude/CLAUDE.md", "claude-md"],
    ["README.md", "readme"],
    ["package.json", "package-json"],
    ["tsconfig.json", "tsconfig"],
    ["pyproject.toml", "pyproject"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go-mod"],
];
const within = (root, p) => p === root || p.startsWith(root + sep);
async function readBounded(path, maxBytes) {
    const fh = await open(path, "r");
    try {
        const size = (await fh.stat()).size;
        const buf = Buffer.alloc(Math.min(size, maxBytes));
        await fh.read(buf, 0, buf.length, 0);
        return { text: buf.toString("utf8"), size };
    }
    finally {
        await fh.close();
    }
}
export async function discoverInstructions(root, cwd, maxBytes) {
    const realRoot = await realpath(root).catch(() => root);
    const candidates = [];
    // Directories from the project root down to the cwd, as Claude Code reads CLAUDE.md files.
    const dirs = [root];
    const relCwd = relative(root, cwd);
    if (relCwd && !relCwd.startsWith("..")) {
        let acc = root;
        for (const part of relCwd.split(sep))
            dirs.push((acc = join(acc, part)));
    }
    for (const [name, type] of ROOT_ONLY)
        candidates.push({ rel: name, type, scope: "project-root" });
    for (const d of dirs) {
        for (const [name, type] of PER_DIR) {
            candidates.push({ rel: relative(root, join(d, name)), type, scope: d === root ? "project-root" : "cwd-ancestor" });
        }
    }
    const out = [];
    for (const c of candidates) {
        const abs = join(root, c.rel);
        try {
            await lstat(abs);
        }
        catch {
            continue; // absent
        }
        const entry = { path: c.rel, type: c.type, scope: c.scope, bytes: null, read: false, content: null, estimatedTokens: 0 };
        try {
            const real = await realpath(abs);
            if (!within(realRoot, real))
                throw new Error("resolves outside the project root; not read");
            const { text, size } = await readBounded(real, maxBytes);
            entry.bytes = size;
            entry.content = excerpt(text, maxBytes);
            if (size > maxBytes)
                entry.content = { ...entry.content, truncated: true, originalLength: size };
            entry.read = true;
            entry.estimatedTokens = estimateTokens(entry.content.text.length);
            if (c.type === "package-json")
                entry.summary = summarizePackageJson(text);
        }
        catch (e) {
            const err = e;
            entry.error = err.code === "ENOENT" ? "broken symlink" : err.code === "EACCES" ? "permission denied" : err.message;
        }
        out.push(entry);
    }
    return out;
}
function summarizePackageJson(text) {
    try {
        const pkg = JSON.parse(text);
        const keys = (o) => (o && typeof o === "object" ? Object.keys(o) : []);
        return {
            name: pkg.name,
            packageManager: pkg.packageManager,
            scripts: pkg.scripts ?? {},
            dependencies: keys(pkg.dependencies),
            devDependencies: keys(pkg.devDependencies),
        };
    }
    catch {
        return undefined;
    }
}
