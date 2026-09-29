import { spawn } from "node:child_process";

export interface Clipboard {
  readonly name: string;
  copy(text: string): Promise<void>;
}

/** macOS clipboard via pbcopy. */
export class MacosClipboard implements Clipboard {
  readonly name = "pbcopy";
  constructor(private readonly bin = "pbcopy") {}

  copy(text: string): Promise<void> {
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

export class UnsupportedClipboard implements Clipboard {
  readonly name = "none";
  constructor(private readonly platform: string) {}
  copy(): Promise<void> {
    return Promise.reject(new Error(`clipboard is only supported on macOS (this is ${this.platform})`));
  }
}

export function defaultClipboard(platform: NodeJS.Platform = process.platform): Clipboard {
  return platform === "darwin" ? new MacosClipboard() : new UnsupportedClipboard(platform);
}
