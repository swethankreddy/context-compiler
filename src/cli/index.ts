#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
}).then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    process.stderr.write(`ccp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
