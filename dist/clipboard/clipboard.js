import { spawn } from "node:child_process";
/** macOS clipboard via pbcopy. */
export class MacosClipboard {
    bin;
    name = "pbcopy";
    constructor(bin = "pbcopy") {
        this.bin = bin;
    }
    copy(text) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.bin, [], { stdio: ["pipe", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (d) => (stderr += d));
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${this.bin} exited ${code}: ${stderr.trim()}`))));
            child.stdin.end(text);
        });
    }
}
export class UnsupportedClipboard {
    platform;
    name = "none";
    constructor(platform) {
        this.platform = platform;
    }
    copy() {
        return Promise.reject(new Error(`clipboard is only supported on macOS (this is ${this.platform})`));
    }
}
export function defaultClipboard(platform = process.platform) {
    return platform === "darwin" ? new MacosClipboard() : new UnsupportedClipboard(platform);
}
