import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSession, projectSlug } from "../src/context/claude-session.js";
import { makeClaudeHome, registerLiveSession } from "./helpers.js";

const CWD = "/work/demo-app";
const A = "aaaaaaaa-0000-0000-0000-000000000000";
const B = "bbbbbbbb-0000-0000-0000-000000000000";
const DEAD_PID = 999_999;

describe("projectSlug", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(projectSlug("/Volumes/Asus Rog St/Claude-code-prompt")).toBe("-Volumes-Asus-Rog-St-Claude-code-prompt");
  });
});

describe("findSession", () => {
  it("prefers a live session registered for this directory", async () => {
    const home = await makeClaudeHome(CWD, [
      { sessionId: A, fixture: "auth-session.jsonl", mtime: new Date(2026, 0, 2) },
      { sessionId: B, fixture: "auth-session.jsonl", mtime: new Date(2026, 0, 1) },
    ]);
    await registerLiveSession(home, { pid: process.pid, sessionId: B, cwd: CWD, updatedAt: 1 });
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home });
    expect(loc.method).toBe("live-session");
    expect(loc.sessionId).toBe(B);
    expect(loc.transcriptPath).toBe(join(home, "projects", projectSlug(CWD), `${B}.jsonl`));
  });

  it("ignores dead processes and sessions from other directories", async () => {
    const home = await makeClaudeHome(CWD, [{ sessionId: A, fixture: "auth-session.jsonl" }]);
    await registerLiveSession(home, { pid: DEAD_PID, sessionId: A, cwd: CWD, updatedAt: 5 });
    await registerLiveSession(home, { pid: process.pid, sessionId: A, cwd: "/elsewhere", updatedAt: 9 });
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home });
    expect(loc.method).toBe("recent-transcript");
    expect(loc.sessionId).toBe(A);
  });

  it("falls back to the most recently modified transcript", async () => {
    const home = await makeClaudeHome(CWD, [
      { sessionId: A, fixture: "auth-session.jsonl", mtime: new Date(2026, 0, 1) },
      { sessionId: B, fixture: "auth-session.jsonl", mtime: new Date(2026, 0, 3) },
    ]);
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home });
    expect(loc.sessionId).toBe(B);
    expect(loc.alternatives.map((a) => a.sessionId)).toEqual([A]);
  });

  it("reports ambiguity when several live sessions match", async () => {
    const home = await makeClaudeHome(CWD, [
      { sessionId: A, fixture: "auth-session.jsonl" },
      { sessionId: B, fixture: "auth-session.jsonl" },
    ]);
    await registerLiveSession(home, { pid: process.pid, sessionId: A, cwd: CWD, updatedAt: 10 });
    await registerLiveSession(home, { pid: process.ppid, sessionId: B, cwd: CWD, updatedAt: 20 });
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home });
    expect(loc.sessionId).toBe(B);
    expect(loc.alternatives.map((a) => a.sessionId)).toEqual([A]);
    expect(loc.notes.join()).toContain("--session");
  });

  it("honours an explicit session id and rejects ids outside this project", async () => {
    const home = await makeClaudeHome(CWD, [{ sessionId: A, fixture: "auth-session.jsonl" }]);
    expect((await findSession({ cwd: CWD, projectRoot: CWD, home, sessionId: A })).method).toBe("explicit");
    expect((await findSession({ cwd: CWD, projectRoot: CWD, home, sessionId: B })).method).toBe("none");
  });

  it("returns none when the project has no transcripts", async () => {
    const home = await makeClaudeHome("/other", []);
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home });
    expect(loc.method).toBe("none");
  });

  it("also looks under the git root when run from a subdirectory", async () => {
    const home = await makeClaudeHome(CWD, [{ sessionId: A, fixture: "auth-session.jsonl" }]);
    const loc = await findSession({ cwd: `${CWD}/packages/web`, projectRoot: CWD, home });
    expect(loc.sessionId).toBe(A);
  });
});

describe("invoking session (ccp run from inside Claude Code's shell)", () => {
  it("uses CLAUDE_CODE_SESSION_ID when it has a transcript in this project", async () => {
    const home = await makeClaudeHome(CWD, [{ sessionId: A, fixture: "auth-session.jsonl" }, { sessionId: B, fixture: "auth-session.jsonl" }]);
    await registerLiveSession(home, { pid: process.pid, sessionId: B, cwd: CWD, updatedAt: 99 });
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home, invokingSessionId: A });
    expect(loc).toMatchObject({ method: "invoking-session", sessionId: A });
  });

  it("ignores an invoking session id from another project", async () => {
    const home = await makeClaudeHome(CWD, [{ sessionId: A, fixture: "auth-session.jsonl" }]);
    const loc = await findSession({ cwd: CWD, projectRoot: CWD, home, invokingSessionId: B });
    expect(loc).toMatchObject({ method: "recent-transcript", sessionId: A });
  });
});
