import { execFile } from "node:child_process";
/** Runs a command without a shell. Never throws; failures come back as `ok: false`. */
export function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") });
        });
    });
}
