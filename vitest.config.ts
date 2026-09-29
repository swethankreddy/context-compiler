import { defineConfig } from "vitest/config";

// benchmark/tasks/** holds task repositories and hidden tests that fail on purpose; they are run by the benchmark runner, not by vitest.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
