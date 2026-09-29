import { describe, expect, it } from "vitest";
import { inferShellWrites, isBenignExit1, isTestCommand, isVerificationCommand, lastCommandName, tokenize } from "../src/context/analysis/shell.js";

const paths = (cmd: string, base = "/p") => inferShellWrites(cmd, base).map((w) => `${w.operation}:${w.path}:${w.via}`);

describe("inferShellWrites", () => {
  it("finds redirects, tee, touch, cp/mv, sed -i and rm", () => {
    expect(paths("echo a > out.txt && echo b >> log.txt")).toEqual(["write:/p/out.txt:redirect", "write:/p/log.txt:redirect"]);
    expect(paths("npm test | tee results.txt")).toEqual(["write:/p/results.txt:tee"]);
    expect(paths("touch a.ts b.ts")).toEqual(["write:/p/a.ts:touch", "write:/p/b.ts:touch"]);
    expect(paths("cp src/a.ts src/b.ts")).toEqual(["write:/p/src/b.ts:cp"]);
    expect(paths("mv old.ts new.ts")).toEqual(["write:/p/new.ts:mv", "delete:/p/old.ts:mv"]);
    expect(paths("sed -i '' 's/x/y/' src/a.ts")).toEqual(["write:/p/src/a.ts:sed -i"]);
    expect(paths("rm -f build.log")).toEqual(["delete:/p/build.log:rm"]);
  });

  it("ignores stderr redirects, /dev/null and redirects inside quotes or heredoc bodies", () => {
    expect(paths("npm test 2>/dev/null > /dev/null")).toEqual([]);
    expect(paths("cmd 2> err.log")).toEqual([]);
    expect(paths('echo "a > b"')).toEqual([]);
    expect(paths("cat > gen.ts <<'EOF'\nconst f = (a) => a > 1;\nEOF")).toEqual(["write:/p/gen.ts:redirect"]);
  });

  it("follows cd for relative paths, including quoted directories", () => {
    expect(paths('cd "/Volumes/My Disk/app" && echo x > a.txt')).toEqual(["write:/Volumes/My Disk/app/a.txt:redirect"]);
  });

  it("marks paths with shell expansions as low confidence and leaves them unresolved", () => {
    expect(inferShellWrites("echo x > $OUT/a.txt", "/p")).toEqual([{ path: "$OUT/a.txt", operation: "write", via: "redirect", confidence: "low" }]);
  });

  it("returns nothing for read-only commands", () => {
    expect(paths("git status && ls -la | grep foo")).toEqual([]);
  });
});

describe("command classification", () => {
  it("recognises test and verification commands", () => {
    expect(isTestCommand("npm test -- auth")).toBe(true);
    expect(isTestCommand("npx vitest run")).toBe(true);
    expect(isTestCommand("pytest -k login")).toBe(true);
    expect(isTestCommand("npm run build")).toBe(false);
    expect(isVerificationCommand("npm run build")).toBe(true);
    expect(isVerificationCommand("npx tsc --noEmit")).toBe(true);
    expect(isVerificationCommand("npm run -s typecheck && npm run -s build")).toBe(true);
    expect(isTestCommand("npm --silent test")).toBe(true);
    expect(isVerificationCommand("ls")).toBe(false);
  });

  it("treats exit 1 from grep/diff as benign", () => {
    expect(lastCommandName("cd src && grep -rn foo .")).toBe("grep");
    expect(isBenignExit1("grep foo a.ts", 1)).toBe(true);
    expect(isBenignExit1("grep foo a.ts", 2)).toBe(false);
    expect(isBenignExit1("git diff --exit-code", 1)).toBe(true);
    expect(isBenignExit1("npm test", 1)).toBe(false);
  });

  it("tokenizes fd redirects as operators", () => {
    expect(tokenize("a 2>&1")).toEqual([{ t: "word", v: "a" }, { t: "op", v: "2>&" }, { t: "word", v: "1" }]);
  });
});

describe("isCompoundCommand", () => {
  it("detects command lists, pipes and loops", async () => {
    const { isCompoundCommand } = await import("../src/context/analysis/shell.js");
    expect(isCompoundCommand("npm test")).toBe(false);
    expect(isCompoundCommand("npm test 2>&1")).toBe(false);
    expect(isCompoundCommand("npm run build && npm test")).toBe(true);
    expect(isCompoundCommand("npx vitest run | tail -5")).toBe(true);
    expect(isCompoundCommand("for q in a b; do echo $q; done")).toBe(true);
  });
});
