import { chmod, copyFile, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSlug } from "../src/context/claude-session.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function tempDir(prefix = "ccp-test-"): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Builds a fake ~/.claude with the given transcripts filed under `projectDir`. */
export async function makeClaudeHome(
  projectDir: string,
  transcripts: { sessionId: string; fixture: string; mtime?: Date }[],
): Promise<string> {
  const home = await tempDir("ccp-claude-home-");
  const dir = join(home, "projects", projectSlug(projectDir));
  await mkdir(dir, { recursive: true });
  await mkdir(join(home, "sessions"), { recursive: true });
  for (const t of transcripts) {
    const dest = join(dir, `${t.sessionId}.jsonl`);
    await copyFile(join(FIXTURES, "transcripts", t.fixture), dest);
    if (t.mtime) {
      const { utimes } = await import("node:fs/promises");
      await utimes(dest, t.mtime, t.mtime);
    }
  }
  return home;
}

export async function registerLiveSession(
  home: string,
  s: { pid: number; sessionId: string; cwd: string; updatedAt: number; kind?: string },
): Promise<void> {
  await writeFile(join(home, "sessions", `${s.pid}.json`), JSON.stringify({ kind: "interactive", status: "idle", version: "2.1.283", ...s }));
}

/**
 * A stand-in `claude` binary. `--version` prints a version; `-p` acts as the compiler:
 * logs {args, cwd, input} to $CCP_FAKE_LOG, returns $CCP_FAKE_RESPONSE (a full `claude -p`
 * JSON result) or a default whose instruction is "COMPILED: <user instruction>", and exits
 * with $CCP_FAKE_EXIT. With $CCP_FAKE_ALWAYS_WRITE it writes a transcript for its cwd under
 * $CCP_CLAUDE_HOME even when --no-session-persistence is passed (worst case for isolation).
 */
export async function fakeClaudeBin(version = "2.1.283"): Promise<string> {
  const dir = await tempDir("ccp-bin-");
  const bin = join(dir, "claude");
  await writeFile(
    bin,
    `#!${process.execPath}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2), env = process.env;
if (args[0] === "--version") { console.log("${version} (Claude Code)"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (env.CCP_FAKE_LOG) fs.writeFileSync(env.CCP_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), input }));
  if (env.CCP_CLAUDE_HOME && (env.CCP_FAKE_ALWAYS_WRITE || !args.includes("--no-session-persistence"))) {
    const d = path.join(env.CCP_CLAUDE_HOME, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "ffffffff-0000-0000-0000-000000000000.jsonl"), JSON.stringify({ type: "user", cwd: process.cwd(), message: { role: "user", content: "compiler call" } }) + "\\n");
  }
  const m = input.match(/<user_instruction>\\n([\\s\\S]*?)\\n<\\/user_instruction>/);
  const out = env.CCP_FAKE_RESPONSE ? JSON.parse(env.CCP_FAKE_RESPONSE) : {
    type: "result", subtype: "success", is_error: false, result: "",
    structured_output: { version: 1, instruction: "COMPILED: " + (m ? m[1] : ""), mode: "context_enriched", contextUsed: [], warnings: [] },
    usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "claude-opus-5-5": {} }, total_cost_usd: 0.001,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(Number(env.CCP_FAKE_EXIT || 0));
});
`,
  );
  await chmod(bin, 0o755);
  return bin;
}
