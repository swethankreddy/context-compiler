import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MacosClipboard, UnsupportedClipboard } from "../src/clipboard/clipboard.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config/config.js";
import { tempDir } from "./helpers.js";

describe("loadConfig", () => {
  it("defaults to claude-cli, claude-opus-5-5 and medium effort", async () => {
    const cfg = await loadConfig({ CCP_CONFIG_DIR: await tempDir() });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.provider).toBe("claude-cli");
    expect(cfg.model).toEqual({ name: "claude-opus-5-5", effort: "medium" });
  });

  it("merges a partial YAML file over the defaults", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "config.yaml"), "model:\n  effort: low\ncontext:\n  max_session_turns: 5\n");
    const cfg = await loadConfig({ CCP_CONFIG_DIR: dir });
    expect(cfg.model).toEqual({ name: "claude-opus-5-5", effort: "low" });
    expect(cfg.context.max_session_turns).toBe(5);
    expect(cfg.context.max_files).toBe(12);
  });

  it("rejects an unknown effort level", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "config.yaml"), "model:\n  effort: extreme\n");
    await expect(loadConfig({ CCP_CONFIG_DIR: dir })).rejects.toThrow(/effort/);
  });
});

describe("clipboard", () => {
  it("pipes text to the clipboard command", async () => {
    await expect(new MacosClipboard("cat").copy("hello")).resolves.toBeUndefined();
  });

  it("surfaces a failing clipboard command", async () => {
    await expect(new MacosClipboard("false").copy("x")).rejects.toThrow(/exited 1/);
  });

  it("refuses on unsupported platforms", async () => {
    await expect(new UnsupportedClipboard("linux").copy()).rejects.toThrow(/macOS/);
  });
});
