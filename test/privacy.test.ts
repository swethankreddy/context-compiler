/**
 * Records every filesystem path the context layer touches and checks that it stays
 * away from credentials, prompt history, session keys and other projects.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const touched: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  const wrap = <F extends (...a: any[]) => any>(f: F) =>
    ((...a: Parameters<F>) => {
      touched.push(String(a[0]));
      return f(...a);
    }) as F;
  return {
    ...orig,
    readFile: wrap(orig.readFile),
    readdir: wrap(orig.readdir),
    stat: wrap(orig.stat),
    lstat: wrap(orig.lstat),
    open: wrap(orig.open),
    realpath: wrap(orig.realpath),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    createReadStream: (p: string, o?: unknown) => {
      touched.push(String(p));
      return orig.createReadStream(p, o as never);
    },
  };
});

const { discoverContext } = await import("../src/context/discover.js");
const { DEFAULT_CONFIG } = await import("../src/config/config.js");
const { makeClaudeHome, registerLiveSession, tempDir, fakeClaudeBin } = await import("./helpers.js");
const { projectSlug } = await import("../src/context/claude-session.js");

describe("context discovery file access", () => {
  beforeEach(() => void (touched.length = 0));

  it("never touches credentials, history, session keys or other projects", async () => {
    const cwd = await tempDir("ccp-project-");
    const SESSION = "11111111-2222-3333-4444-555555555555";
    const home = await makeClaudeHome(cwd, [{ sessionId: SESSION, fixture: "auth-session.jsonl" }]);
    await writeFile(join(home, ".credentials.json"), "{}");
    await writeFile(join(home, "history.jsonl"), "{}");
    await writeFile(join(home, "sessions", `${process.pid}.deadbeef.key`), "{}");
    await registerLiveSession(home, { pid: process.pid, sessionId: SESSION, cwd, updatedAt: 1 });
    const other = join(home, "projects", projectSlug("/some/other/project"));
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "99999999-0000-0000-0000-000000000000.jsonl"), "{}");

    const snap = await discoverContext({
      cwd,
      config: DEFAULT_CONFIG,
      env: { CCP_CLAUDE_HOME: home, CCP_CLAUDE_BIN: await fakeClaudeBin() },
    });
    expect(snap.session.status).toBe("loaded");
    // The recorder must actually see reads, or the checks below prove nothing.
    expect(touched).toContain(join(home, "projects", projectSlug(cwd), `${SESSION}.jsonl`));

    const forbidden = touched.filter(
      (p) => p.includes(".credentials") || p.includes("history.jsonl") || p.endsWith(".key") || p.startsWith(other),
    );
    expect(forbidden).toEqual([]);
    // Everything under the Claude home is the registry or this project's folder.
    const projectDir = join(home, "projects", projectSlug(cwd));
    const underHome = touched.filter((p) => p.startsWith(home));
    expect(underHome.every((p) => p.startsWith(join(home, "sessions")) || p.startsWith(projectDir))).toBe(true);
  });
});
