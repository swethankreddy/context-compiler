/**
 * Discovers project-level instruction and configuration files.
 *
 * Only files inside the project root are read. A file (or symlink) that resolves outside
 * the root is listed but not read. Content is bounded; Phase 4 decides what is relevant.
 */
import { open, lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Excerpt } from "./adapters/types.js";
import { estimateTokens, excerpt } from "./excerpt.js";

export type InstructionType =
  | "claude-md"
  | "claude-local-md"
  | "agents-md"
  | "readme"
  | "package-json"
  | "tsconfig"
  | "pyproject"
  | "cargo"
  | "go-mod";

export interface InstructionFile {
  /** Path relative to the project root. */
  path: string;
  type: InstructionType;
  /** Where it sits relative to the working directory. */
  scope: "project-root" | "cwd-ancestor";
  bytes: number | null;
  read: boolean;
  error?: string;
  content: Excerpt | null;
  estimatedTokens: number;
  /** Small structured summary for config files (e.g. package.json scripts). */
  summary?: Record<string, unknown>;
}

const PER_DIR: [string, InstructionType][] = [
  ["CLAUDE.md", "claude-md"],
  ["CLAUDE.local.md", "claude-local-md"],
  ["AGENTS.md", "agents-md"],
];
const ROOT_ONLY: [string, InstructionType][] = [
  [".claude/CLAUDE.md", "claude-md"],
  ["README.md", "readme"],
  ["package.json", "package-json"],
  ["tsconfig.json", "tsconfig"],
  ["pyproject.toml", "pyproject"],
  ["Cargo.toml", "cargo"],
  ["go.mod", "go-mod"],
];

const within = (root: string, p: string) => p === root || p.startsWith(root + sep);

async function readBounded(path: string, maxBytes: number): Promise<{ text: string; size: number }> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    await fh.read(buf, 0, buf.length, 0);
    return { text: buf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

export async function discoverInstructions(root: string, cwd: string, maxBytes: number): Promise<InstructionFile[]> {
  const realRoot = await realpath(root).catch(() => root);
  const candidates: { rel: string; type: InstructionType; scope: InstructionFile["scope"] }[] = [];

  // Directories from the project root down to the cwd, as Claude Code reads CLAUDE.md files.
  const dirs = [root];
  const relCwd = relative(root, cwd);
  if (relCwd && !relCwd.startsWith("..")) {
    let acc = root;
    for (const part of relCwd.split(sep)) dirs.push((acc = join(acc, part)));
  }
  for (const [name, type] of ROOT_ONLY) candidates.push({ rel: name, type, scope: "project-root" });
  for (const d of dirs) {
    for (const [name, type] of PER_DIR) {
      candidates.push({ rel: relative(root, join(d, name)), type, scope: d === root ? "project-root" : "cwd-ancestor" });
    }
  }

  const out: InstructionFile[] = [];
  for (const c of candidates) {
    const abs = join(root, c.rel);
    try {
      await lstat(abs);
    } catch {
      continue; // absent
    }
    const entry: InstructionFile = { path: c.rel, type: c.type, scope: c.scope, bytes: null, read: false, content: null, estimatedTokens: 0 };
    try {
      const real = await realpath(abs);
      if (!within(realRoot, real)) throw new Error("resolves outside the project root; not read");
      const { text, size } = await readBounded(real, maxBytes);
      entry.bytes = size;
      entry.content = excerpt(text, maxBytes);
      if (size > maxBytes) entry.content = { ...entry.content, truncated: true, originalLength: size };
      entry.read = true;
      entry.estimatedTokens = estimateTokens(entry.content.text.length);
      if (c.type === "package-json") entry.summary = summarizePackageJson(text);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      entry.error = err.code === "ENOENT" ? "broken symlink" : err.code === "EACCES" ? "permission denied" : err.message;
    }
    out.push(entry);
  }
  return out;
}

function summarizePackageJson(text: string): Record<string, unknown> | undefined {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o) : []);
    return {
      name: pkg.name,
      packageManager: pkg.packageManager,
      scripts: pkg.scripts ?? {},
      dependencies: keys(pkg.dependencies),
      devDependencies: keys(pkg.devDependencies),
    };
  } catch {
    return undefined;
  }
}
