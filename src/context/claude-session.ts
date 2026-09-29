/**
 * Finds the Claude Code session relevant to the current project.
 *
 * Only files belonging to the current project are touched:
 *   - ~/.claude/sessions/<pid>.json   (live-session registry; `.key` files are never read)
 *   - ~/.claude/projects/<slug>/      (transcripts for this project's directory only)
 * history.jsonl, credentials and other projects' transcripts are never opened.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../util/exec.js";

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCP_CLAUDE_HOME ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Claude Code names a project's transcript folder after its cwd with every non-alphanumeric char replaced by "-". */
export function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string | null;
  kind: string | null;
  name: string | null;
  version: string | null;
  updatedAt: number;
  alive: boolean;
}

/**
 * invoking-session: ccp was started from inside a Claude Code session's own shell, which sets
 * CLAUDE_CODE_SESSION_ID. That names the session exactly.
 */
export type DetectionMethod = "explicit" | "invoking-session" | "live-session" | "recent-transcript" | "none";

export interface SessionLocation {
  method: DetectionMethod;
  sessionId: string | null;
  transcriptPath: string | null;
  live: LiveSession | null;
  /** Other sessions that also matched this project (for ambiguity reporting). */
  alternatives: { sessionId: string; transcriptPath: string; updatedAt: number; live: boolean }[];
  notes: string[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function listLiveSessions(home: string): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = await readdir(join(home, "sessions"));
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    try {
      const d = JSON.parse(await readFile(join(home, "sessions", name), "utf8")) as Record<string, unknown>;
      if (typeof d.pid !== "number" || typeof d.sessionId !== "string" || typeof d.cwd !== "string") continue;
      out.push({
        pid: d.pid,
        sessionId: d.sessionId,
        cwd: d.cwd,
        status: typeof d.status === "string" ? d.status : null,
        kind: typeof d.kind === "string" ? d.kind : null,
        name: typeof d.name === "string" ? d.name : null,
        version: typeof d.version === "string" ? d.version : null,
        updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
        alive: isAlive(d.pid),
      });
    } catch {
      // A registry entry being rewritten mid-read is not fatal.
    }
  }
  return out;
}

async function listTranscripts(dir: string): Promise<{ sessionId: string; path: string; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl") || n.startsWith("._")) continue;
    const path = join(dir, n);
    try {
      out.push({ sessionId: n.slice(0, -".jsonl".length), path, mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // Deleted between readdir and stat.
    }
  }
  return out;
}

export interface FindSessionOptions {
  cwd: string;
  projectRoot: string;
  home?: string;
  sessionId?: string;
  /** CLAUDE_CODE_SESSION_ID from the environment, when ccp runs inside a Claude Code shell. */
  invokingSessionId?: string;
}

export async function findSession(opts: FindSessionOptions): Promise<SessionLocation> {
  const home = opts.home ?? claudeHome();
  const dirs = [...new Set([opts.cwd, opts.projectRoot])];
  const projectDirs = dirs.map((d) => join(home, "projects", projectSlug(d)));
  const transcripts = (await Promise.all(projectDirs.map(listTranscripts))).flat();
  const byId = new Map(transcripts.map((t) => [t.sessionId, t]));
  const notes: string[] = [];
  const none: SessionLocation = { method: "none", sessionId: null, transcriptPath: null, live: null, alternatives: [], notes };

  if (opts.sessionId) {
    const t = byId.get(opts.sessionId);
    if (!t) {
      notes.push(`Session ${opts.sessionId} has no transcript under this project's folder.`);
      return none;
    }
    return { method: "explicit", sessionId: t.sessionId, transcriptPath: t.path, live: null, alternatives: [], notes };
  }

  if (opts.invokingSessionId) {
    const t = byId.get(opts.invokingSessionId);
    if (t) {
      notes.push("ccp is running inside this Claude Code session's shell; its own command is excluded from the context.");
      return { method: "invoking-session", sessionId: t.sessionId, transcriptPath: t.path, live: null, alternatives: [], notes };
    }
  }

  const live = (await listLiveSessions(home))
    .filter((s) => s.alive && dirs.includes(s.cwd) && (s.kind === null || s.kind === "interactive") && byId.has(s.sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (live.length > 0) {
    const pick = live[0]!;
    const alternatives = live.slice(1).map((s) => ({
      sessionId: s.sessionId, transcriptPath: byId.get(s.sessionId)!.path, updatedAt: s.updatedAt, live: true,
    }));
    if (alternatives.length) notes.push(`${live.length} live sessions in this project; picked the most recently active. Use --session <id> to choose.`);
    return { method: "live-session", sessionId: pick.sessionId, transcriptPath: byId.get(pick.sessionId)!.path, live: pick, alternatives, notes };
  }

  if (transcripts.length === 0) {
    notes.push("No Claude Code transcripts found for this directory.");
    return none;
  }
  const sorted = [...transcripts].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pick = sorted[0]!;
  notes.push("No live Claude Code session in this project; using the most recently modified transcript.");
  return {
    method: "recent-transcript",
    sessionId: pick.sessionId,
    transcriptPath: pick.path,
    live: null,
    alternatives: sorted.slice(1, 5).map((t) => ({ sessionId: t.sessionId, transcriptPath: t.path, updatedAt: t.mtimeMs, live: false })),
    notes,
  };
}

/** Installed Claude Code version from `claude --version`, or null if the CLI isn't available. */
export async function detectClaudeCodeVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const r = await run(env.CCP_CLAUDE_BIN ?? "claude", ["--version"], { timeoutMs: 10_000 });
  if (!r.ok) return null;
  return r.stdout.trim().match(/^(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
}
