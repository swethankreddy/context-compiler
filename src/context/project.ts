import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GitContext } from "./git.js";

export interface ProjectInfo {
  root: string;
  name: string;
  packageManager: string | null;
}

const LOCKFILES: [string, string][] = [
  ["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"],
  ["uv.lock", "uv"], ["poetry.lock", "poetry"], ["Cargo.lock", "cargo"], ["go.sum", "go"],
];

const exists = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/** The project root is the Git top-level when there is one, otherwise the working directory. */
export async function detectProject(cwd: string, git: GitContext): Promise<ProjectInfo> {
  const root = git.available ? git.root : cwd;
  let name = basename(root);
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name) name = pkg.name;
  } catch {
    // No package.json, or not JSON: keep the directory name.
  }
  let packageManager: string | null = null;
  for (const [lock, pm] of LOCKFILES) {
    if (await exists(join(root, lock))) {
      packageManager = pm;
      break;
    }
  }
  return { root, name, packageManager };
}
