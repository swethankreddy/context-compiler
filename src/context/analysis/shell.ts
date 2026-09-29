/**
 * Best-effort inference of files a shell command wrote or deleted.
 *
 * This is deliberately NOT a full shell parser. It recognises a handful of explicit
 * write forms (redirects, tee, sed -i, cp/mv, touch, rm) in simple command lists and
 * returns them as *inferred* changes. Anything it can't understand is ignored.
 */
import { isAbsolute, resolve } from "node:path";

export interface InferredWrite {
  path: string;
  operation: "write" | "delete";
  via: "redirect" | "tee" | "sed -i" | "cp" | "mv" | "touch" | "rm";
  /** low when the path contains shell expansions we can't resolve. */
  confidence: "medium" | "low";
}

type Tok = { t: "word"; v: string } | { t: "op"; v: string };

const SEPARATORS = new Set(["&&", "||", "|", ";", "\n", "&", "(", ")"]);

/** Removes here-document bodies, keeping the line that introduces them. */
export function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<HEREDOC$3");
}

/** Quote-aware tokenizer for simple shell command lists. */
export function tokenize(cmd: string): Tok[] {
  const out: Tok[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) out.push({ t: "word", v: word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1);
      const stop = end === -1 ? cmd.length : end;
      word += cmd.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] !== "\n") {
        word += cmd[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === " " || c === "\t") {
      flush();
    } else if ("|&;<>()\n".includes(c)) {
      // An fd number glued to a redirect (2>, 1>>) belongs to the operator.
      let fd = "";
      if ((c === ">" || c === "<") && inWord && /^\d$/.test(word)) {
        fd = word;
        word = "";
        inWord = false;
      }
      flush();
      const two = cmd.slice(i, i + 2);
      if (["&&", "||", ">>", "&>", ">&", "<<"].includes(two)) {
        out.push({ t: "op", v: fd + two });
        i++;
      } else {
        out.push({ t: "op", v: fd + c });
      }
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return out;
}

const hasExpansion = (p: string) => /[$`*?{}~]/.test(p);

export function inferShellWrites(command: string, baseDir: string): InferredWrite[] {
  const toks = tokenize(stripHeredocs(command));
  const found: InferredWrite[] = [];
  let dir = baseDir;
  const add = (raw: string, operation: InferredWrite["operation"], via: InferredWrite["via"]) => {
    if (!raw || raw === "/dev/null" || raw.startsWith("/dev/")) return;
    const low = hasExpansion(raw);
    found.push({
      path: low || isAbsolute(raw) ? raw : resolve(dir, raw),
      operation,
      via,
      confidence: low ? "low" : "medium",
    });
  };

  let seg: Tok[] = [];
  const endSegment = () => {
    const words: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      const tk = seg[i]!;
      if (tk.t === "op") {
        const next = seg[i + 1];
        // stdout / combined redirects write a file; stderr-only (2>) redirects are ignored as log noise.
        if ((tk.v === ">" || tk.v === ">>" || tk.v === "1>" || tk.v === "1>>" || tk.v === "&>") && next?.t === "word") {
          add(next.v, "write", "redirect");
          i++;
        } else if (/[<>]/.test(tk.v) && next?.t === "word") {
          i++; // any other redirect (2>, 2>&, <, <<): its target is not a command argument
        }
        continue;
      }
      words.push(tk.v);
    }
    const [cmd, ...rest] = words;
    const args = rest.filter((a) => !a.startsWith("-"));
    switch (cmd) {
      case "cd":
        if (args[0] && !hasExpansion(args[0])) dir = resolve(dir, args[0]);
        break;
      case "tee":
        args.forEach((a) => add(a, "write", "tee"));
        break;
      case "sed":
        if (rest.some((a) => /^-i/.test(a) || a === "--in-place") && args.length >= 2) add(args[args.length - 1]!, "write", "sed -i");
        break;
      case "cp":
      case "mv":
        if (args.length >= 2) add(args[args.length - 1]!, "write", cmd);
        if (cmd === "mv" && args.length === 2) add(args[0]!, "delete", "mv");
        break;
      case "touch":
        args.forEach((a) => add(a, "write", "touch"));
        break;
      case "rm":
        args.forEach((a) => add(a, "delete", "rm"));
        break;
    }
    seg = [];
  };
  for (const tk of toks) {
    if (tk.t === "op" && SEPARATORS.has(tk.v)) endSegment();
    else seg.push(tk);
  }
  endSegment();
  return found;
}

const TEST_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run|-\S+)\s+)*test\b|\bnpx\s+(?:vitest|jest|mocha|playwright)\b|\b(?:vitest|jest|mocha|pytest|rspec|phpunit)\b|\bgo\s+test\b|\bcargo\s+test\b|\bplaywright\s+test\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/;
const CHECK_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run|-\S+)\s+)*(?:build|typecheck|type-check|lint|check)\b|\btsc\b|\beslint\b|\bcargo\s+(?:build|check|clippy)\b|\bgo\s+(?:build|vet)\b|\bmypy\b|\bruff\b/;

export const isTestCommand = (cmd: string): boolean => TEST_RE.test(cmd);
/** Commands whose result says whether a change works: tests, builds, type checks, linters. */
export const isVerificationCommand = (cmd: string): boolean => TEST_RE.test(cmd) || CHECK_RE.test(cmd);

/** More than one command (&&, ;, |, loops): its exit status may come from a part other than the check. */
export function isCompoundCommand(command: string): boolean {
  const toks = tokenize(stripHeredocs(command));
  const inner = toks.slice(0, -1);
  return inner.some((t) => t.t === "op" && SEPARATORS.has(t.v)) || toks.some((t) => t.t === "word" && (t.v === "for" || t.v === "while"));
}

/** Commands for which exit code 1 normally means "no match / differs", not an error. */
const EXIT1_BENIGN = new Set(["grep", "rg", "egrep", "fgrep", "diff", "cmp", "test", "[", "git diff"]);

/** First word of the last pipeline stage — the command whose exit status the shell reports. */
export function lastCommandName(command: string): string | null {
  const toks = tokenize(stripHeredocs(command));
  let lastStart = 0;
  toks.forEach((t, i) => {
    if (t.t === "op" && SEPARATORS.has(t.v) && i + 1 < toks.length) lastStart = i + 1;
  });
  const words = toks.slice(lastStart).filter((t): t is { t: "word"; v: string } => t.t === "word");
  if (!words.length) return null;
  return words[0]!.v === "git" && words[1] ? `git ${words[1].v}` : words[0]!.v;
}

export const isBenignExit1 = (command: string, exitCode: number | null): boolean =>
  exitCode === 1 && EXIT1_BENIGN.has(lastCommandName(command) ?? "");
