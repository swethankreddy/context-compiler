import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_CONFIG = {
    provider: "claude-cli",
    model: { name: "claude-opus-5-5", effort: "medium" },
    context: {
        max_session_turns: 20,
        max_files: 12,
        include_git_diff: true,
        include_project_instructions: true,
        // Stored length of developer messages. Normal mode still compresses them during selection;
        // handoff mode keeps them (requirements live in long messages and pasted specs).
        max_prompt_chars: 12000,
        max_response_chars: 600,
        // Stored length of tool output. Normal mode compresses it during selection; handoff mode
        // keeps more so facts that tool output established are not reported as unknown.
        max_tool_output_chars: 4000,
        max_diff_bytes: 8000,
        max_instruction_file_bytes: 16000,
        max_listed_files: 50,
    },
    selection: {
        max_tokens: 6000,
        min_score: 1.0,
        max_turns: 3,
        max_attempts: 3,
        max_failures: 4,
        max_verifications: 3,
        max_files: 8,
        max_instruction_files: 3,
    },
    compiler: { timeout_ms: 120_000, max_input_chars: 24_000 },
    clipboard: { enabled: true },
};
export function configDir(env = process.env) {
    return env.CCP_CONFIG_DIR ?? join(homedir(), ".context-compiler");
}
/** Loads ~/.context-compiler/config.yaml over the defaults. A missing file is not an error. */
export async function loadConfig(env = process.env) {
    const path = join(configDir(env), "config.yaml");
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        return structuredClone(DEFAULT_CONFIG);
    }
    const user = (parseYaml(raw) ?? {});
    const merged = {
        provider: user.provider ?? DEFAULT_CONFIG.provider,
        model: { ...DEFAULT_CONFIG.model, ...user.model },
        context: { ...DEFAULT_CONFIG.context, ...user.context },
        selection: { ...DEFAULT_CONFIG.selection, ...user.selection },
        compiler: { ...DEFAULT_CONFIG.compiler, ...user.compiler },
        clipboard: { ...DEFAULT_CONFIG.clipboard, ...user.clipboard },
    };
    if (!EFFORT_LEVELS.includes(merged.model.effort)) {
        throw new Error(`${path}: model.effort must be one of ${EFFORT_LEVELS.join(", ")}`);
    }
    return merged;
}
