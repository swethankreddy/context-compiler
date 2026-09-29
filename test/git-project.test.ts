import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectGit, parseNumstatZ, parsePorcelainZ, type GitOptions } from "../src/context/git.js";
import { discoverInstructions } from "../src/context/instructions.js";
import { detectProject } from "../src/context/project.js";
import { run } from "../src/util/exec.js";
import { tempDir } from "./helpers.js";

const OPTS: GitOptions = { includeDiff: true, maxDiffBytes: 8000, maxListed: 50 };
const g = (dir: string, ...a: string[]) => run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });

async function repo(): Promise<string> {
  const dir = await tempDir();
  await g(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "one\n");
  await writeFile(join(dir, "old.txt"), "rename me\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo-pkg", scripts: { test: "vitest" } }));
  await g(dir, "add", ".");
  await g(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("detectGit", () => {
  it("reports a clean repository", async () => {
    const dir = await repo();
    const git = await detectGit(dir, OPTS);
    expect(git).toMatchObject({ available: true, root: dir, branch: "main", hasCommits: true, clean: true, changedFiles: [] });
    if (!git.available) throw new Error();
    expect(git.recentCommits[0]).toMatchObject({ subject: "init" });
    expect(git.diff).toMatchObject({ included: false, reason: "no tracked changes" });
  });

  it("separates staged, unstaged and untracked changes with a bounded diff", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await g(dir, "mv", "old.txt", "new.txt");
    await writeFile(join(dir, "staged.txt"), "s\n");
    await g(dir, "add", "staged.txt");
    await writeFile(join(dir, "untracked.txt"), "u\n");
    const git = await detectGit(dir, { ...OPTS, maxDiffBytes: 60 });
    if (!git.available) throw new Error("expected git");
    expect(git.clean).toBe(false);
    expect(git.staged).toEqual(expect.arrayContaining([{ path: "new.txt", status: "R", from: "old.txt" }, { path: "staged.txt", status: "A" }]));
    expect(git.unstaged).toEqual([{ path: "a.txt", status: "M" }]);
    expect(git.untracked).toEqual(["untracked.txt"]);
    expect(git.diffStat.files).toContainEqual({ path: "a.txt", area: "unstaged", added: 1, removed: 0, binary: false });
    expect(git.diff.included).toBe(true);
    expect(git.diff.excerpt).toMatchObject({ truncated: true });
    expect(git.diff.excerpt!.originalLength).toBeGreaterThan(60);
  });

  it("omits the diff when disabled", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "changed\n");
    const git = await detectGit(dir, { ...OPTS, includeDiff: false });
    expect(git).toMatchObject({ diff: { included: false, reason: "disabled in config" } });
  });

  it("handles a repository with no commits", async () => {
    const dir = await tempDir();
    await g(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "x.txt"), "x");
    expect(await detectGit(dir, OPTS)).toMatchObject({ available: true, hasCommits: false, head: null, untracked: ["x.txt"], diff: { reason: "no commits yet" } });
  });

  it("returns a structured result outside a repository", async () => {
    expect(await detectGit(await tempDir(), OPTS)).toEqual({ available: false, reason: "not-a-repository" });
  });

  it("returns a structured result when git is not installed", async () => {
    expect(await detectGit(await tempDir(), { ...OPTS, gitBin: "/nonexistent/git" })).toEqual({ available: false, reason: "git-not-installed" });
  });

  it("parses porcelain and numstat edge cases", () => {
    const into = { staged: [] as { path: string; status: string }[], unstaged: [] as { path: string; status: string }[], untracked: [] as string[] };
    parsePorcelainZ("R  new.ts\0old.ts\0MM both.ts\0?? n.ts\0", into);
    expect(into).toEqual({ staged: [{ path: "new.ts", status: "R", from: "old.ts" }, { path: "both.ts", status: "M" }], unstaged: [{ path: "both.ts", status: "M" }], untracked: ["n.ts"] });
    expect(parseNumstatZ("3\t1\ta.ts\0-\t-\timg.png\0" + "0\t0\t\0old.ts\0new.ts\0", "staged")).toEqual([
      { path: "a.ts", area: "staged", added: 3, removed: 1, binary: false },
      { path: "img.png", area: "staged", added: null, removed: null, binary: true },
      { path: "new.ts", area: "staged", added: 0, removed: 0, binary: false },
    ]);
  });
});

describe("detectProject", () => {
  it("uses the git root, package name and lockfile", async () => {
    const dir = await repo();
    await writeFile(join(dir, "package-lock.json"), "{}");
    await mkdir(join(dir, "sub"));
    const p = await detectProject(join(dir, "sub"), await detectGit(join(dir, "sub"), OPTS));
    expect(p).toEqual({ root: dir, name: "demo-pkg", packageManager: "npm" });
  });

  it("falls back to the working directory without git", async () => {
    const dir = await tempDir("plain-");
    expect((await detectProject(dir, { available: false, reason: "not-a-repository" })).root).toBe(dir);
  });
});

describe("discoverInstructions", () => {
  it("finds CLAUDE.md, AGENTS.md, README and config at the root and CLAUDE.md files down to the cwd", async () => {
    const root = await tempDir();
    await mkdir(join(root, "packages", "web"), { recursive: true });
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, "CLAUDE.md"), "# Root rules\nUse npm.");
    await writeFile(join(root, ".claude", "CLAUDE.md"), "more rules");
    await writeFile(join(root, "AGENTS.md"), "agents");
    await writeFile(join(root, "README.md"), "# Demo");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "d", scripts: { test: "vitest" }, dependencies: { zod: "1" } }));
    await writeFile(join(root, "packages", "web", "CLAUDE.md"), "web rules");
    await writeFile(join(root, "packages", "CLAUDE.md"), "pkg rules");

    const files = await discoverInstructions(root, join(root, "packages", "web"), 16000);
    expect(files.map((f) => [f.path, f.type, f.scope, f.read])).toEqual([
      [".claude/CLAUDE.md", "claude-md", "project-root", true],
      ["README.md", "readme", "project-root", true],
      ["package.json", "package-json", "project-root", true],
      ["CLAUDE.md", "claude-md", "project-root", true],
      ["AGENTS.md", "agents-md", "project-root", true],
      [join("packages", "CLAUDE.md"), "claude-md", "cwd-ancestor", true],
      [join("packages", "web", "CLAUDE.md"), "claude-md", "cwd-ancestor", true],
    ]);
    expect(files.find((f) => f.type === "package-json")!.summary).toMatchObject({ scripts: { test: "vitest" }, dependencies: ["zod"] });
    expect(files.find((f) => f.path === "CLAUDE.md")!.content!.text).toContain("Use npm.");
  });

  it("bounds large files", async () => {
    const root = await tempDir();
    await writeFile(join(root, "README.md"), "x".repeat(50_000));
    const [f] = await discoverInstructions(root, root, 1000);
    expect(f).toMatchObject({ read: true, bytes: 50_000, content: { truncated: true, originalLength: 50_000 } });
    expect(f!.content!.text.length).toBeLessThan(1100);
  });

  it("reports unreadable, dangling and out-of-project files without reading them", async () => {
    const root = await tempDir();
    const outside = await tempDir("outside-");
    await writeFile(join(outside, "secret.md"), "not yours");
    await writeFile(join(root, "CLAUDE.md"), "locked");
    await chmod(join(root, "CLAUDE.md"), 0o000);
    await symlink(join(root, "missing.md"), join(root, "AGENTS.md"));
    await symlink(join(outside, "secret.md"), join(root, "README.md"));
    try {
      const files = await discoverInstructions(root, root, 16000);
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      expect(byPath["CLAUDE.md"]).toMatchObject({ read: false, error: "permission denied", content: null });
      expect(byPath["AGENTS.md"]).toMatchObject({ read: false, error: "broken symlink" });
      expect(byPath["README.md"]).toMatchObject({ read: false, error: expect.stringContaining("outside the project root"), content: null });
    } finally {
      await chmod(join(root, "CLAUDE.md"), 0o644);
    }
  });

  it("returns nothing for an empty project", async () => {
    expect(await discoverInstructions(await tempDir(), "/elsewhere", 16000)).toEqual([]);
  });
});

